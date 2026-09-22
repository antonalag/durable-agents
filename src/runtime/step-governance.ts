import { createHash } from 'node:crypto';
import type {
  BudgetConfig,
  BudgetWarningEvent,
  BudgetExceededEvent,
  ExecutionRun,
  LoopConfig,
  LoopDetectedEvent,
} from '../core/types.js';
import { computeOperationKey } from '../serialization/operation-key.js';
import type { JournalStore } from '../stores/interface.js';
import { checkBudget } from './budget.js';
import type { DurableContextImpl } from './context.js';
import type { EventBus } from './event-bus.js';
import { detectLoop, type StepRecord } from './loop-detector.js';
import {
  SUMMARY_STEP_TIMEOUT_MS,
  withTimeout,
  type RunLifecycleState,
  type TerminationReason,
} from './lifecycle.js';

function hashResult(result: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(result)).digest('hex');
  } catch {
    return '';
  }
}

export interface StepGovernanceOptions {
  ctx: DurableContextImpl;
  store: JournalStore;
  budgetConfig: BudgetConfig | undefined;
  loopConfig: LoopConfig | undefined;
  eventBus: EventBus;
  lifecycle: RunLifecycleState;
  /** The run being governed; its `totals` are mutated in place. */
  activeRun: ExecutionRun;
  /** Seeds the running cost accumulator: 0 for fresh runs, initialCost for recovery. */
  initialRunningCost: number;
  startTime: number;
  requestGracefulStop: (reason: TerminationReason) => void;
}

/**
 * Installs governed `ctx.step` and `ctx.parallel` onto the context: budget
 * enforcement, loop detection, running-cost accumulation, cumulative step
 * counting, and the lifecycle phase gate. Shared by normal execution and
 * recovery so both paths obey the same rules.
 *
 * Replay-awareness matters only under recovery: a step served from the replay
 * cursor was already counted (steps and cost) at its original execution, so it
 * must not be re-counted here. `ctx.wasReplayed(key)` is the discriminator.
 */
export function installStepGovernance(opts: StepGovernanceOptions): void {
  const {
    ctx,
    store,
    budgetConfig,
    loopConfig,
    eventBus,
    lifecycle,
    activeRun,
    initialRunningCost,
    startTime,
    requestGracefulStop,
  } = opts;

  const originalStep = ctx.step.bind(ctx);
  const originalParallel = ctx.parallel.bind(ctx);
  const stepHistory: StepRecord[] = [];
  const warningsEmitted = new Set<string>();
  let runningCost = initialRunningCost;

  // Reflect the seeded baseline into the persisted-facing total so an
  // all-replayed recovery still reports the pre-crash cost; fresh steps add on
  // top. For fresh runs the seed is 0, so this is a no-op.
  activeRun.totals.cost = runningCost;

  const runBudgetCheckAndEmit = (): void => {
    if (!budgetConfig) return;

    const budgetResult = checkBudget({
      totals: activeRun.totals,
      elapsedMs: Date.now() - startTime,
      config: budgetConfig,
    });

    if (
      budgetResult.status === 'warning' &&
      budgetResult.triggeredBy &&
      !warningsEmitted.has(budgetResult.triggeredBy)
    ) {
      warningsEmitted.add(budgetResult.triggeredBy);
      eventBus.emit('budget:warning', {
        type: 'budget:warning',
        timestamp: new Date(),
        runId: activeRun.runId,
        currentCost: activeRun.totals.cost,
        budgetLimit: budgetConfig.maxCostUsd ?? 0,
        percentUsed: budgetResult.percentUsed,
      } satisfies BudgetWarningEvent);
    }

    if (budgetResult.status === 'exceeded') {
      eventBus.emit('budget:exceeded', {
        type: 'budget:exceeded',
        timestamp: new Date(),
        runId: activeRun.runId,
        currentCost: activeRun.totals.cost,
        budgetLimit: budgetConfig.maxCostUsd ?? 0,
        action: 'graceful_stop',
      } satisfies BudgetExceededEvent);
      requestGracefulStop('budget_exceeded');
    }
  };

  ctx.step = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    runBudgetCheckAndEmit();

    if (lifecycle.phase === 'stopping') {
      if (!lifecycle.summaryStepAllowed) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      lifecycle.summaryStepAllowed = false;
      try {
        const summaryResult = await withTimeout(originalStep(name, fn), SUMMARY_STEP_TIMEOUT_MS);
        lifecycle.phase = 'terminated';
        return summaryResult;
      } catch (err) {
        lifecycle.phase = 'terminated';
        throw err;
      }
    }

    if (lifecycle.phase === 'terminated') {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const seqBeforeStep = ctx.currentSequence;
    const result = await originalStep(name, fn);

    const operationKey = computeOperationKey(activeRun.runId, name, seqBeforeStep);

    // A replayed step was already counted at its original execution; counting
    // it again would double both the step total and the running cost.
    if (!ctx.wasReplayed(operationKey)) {
      activeRun.totals.steps++;

      const outcome = await store.getOutcomeByKey(operationKey);
      if (outcome) {
        runningCost += outcome.tokens.costUsd;
        activeRun.totals.cost = runningCost;
      }

      if (loopConfig) {
        stepHistory.push({
          nodeName: name,
          sequence: activeRun.totals.steps,
          outputHash: hashResult(result),
        });

        const loopResult = detectLoop(stepHistory, loopConfig);
        if (loopResult.detected) {
          eventBus.emit('loop:detected', {
            type: 'loop:detected',
            timestamp: new Date(),
            runId: activeRun.runId,
            loopType: loopResult.loopType!,
            detectedAtStep: activeRun.totals.steps,
            repetitions: loopResult.repetitions!,
          } satisfies LoopDetectedEvent);

          if (loopResult.action === 'graceful_stop') {
            requestGracefulStop('loop_detected');
          }
        }
      }
    }

    return result;
  };

  ctx.parallel = async <T>(
    steps: Array<{ name: string; fn: () => T | Promise<T> }>,
  ): Promise<T[]> => {
    runBudgetCheckAndEmit();

    if (lifecycle.phase === 'terminated' || lifecycle.phase === 'stopping') {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const seqBeforeGroup = ctx.currentSequence;
    const results = await originalParallel(steps);

    let freshCount = 0;
    for (let i = 0; i < steps.length; i++) {
      const key = computeOperationKey(activeRun.runId, steps[i].name, seqBeforeGroup + i);
      if (!ctx.wasReplayed(key)) {
        freshCount++;
        const outcome = await store.getOutcomeByKey(key);
        if (outcome) {
          runningCost += outcome.tokens.costUsd;
        }
      }
    }
    activeRun.totals.steps += freshCount;
    activeRun.totals.cost = runningCost;

    runBudgetCheckAndEmit();

    if (loopConfig && freshCount > 0) {
      const stepsBase = activeRun.totals.steps - freshCount;
      let pushed = 0;
      for (let i = 0; i < steps.length; i++) {
        const key = computeOperationKey(activeRun.runId, steps[i].name, seqBeforeGroup + i);
        if (ctx.wasReplayed(key)) continue;
        stepHistory.push({
          nodeName: steps[i].name,
          sequence: stepsBase + pushed + 1,
          outputHash: hashResult(results[i]),
        });
        pushed++;
      }

      const loopResult = detectLoop(stepHistory, loopConfig);
      if (loopResult.detected) {
        eventBus.emit('loop:detected', {
          type: 'loop:detected',
          timestamp: new Date(),
          runId: activeRun.runId,
          loopType: loopResult.loopType!,
          detectedAtStep: activeRun.totals.steps,
          repetitions: loopResult.repetitions!,
        } satisfies LoopDetectedEvent);

        if (loopResult.action === 'graceful_stop') {
          requestGracefulStop('loop_detected');
        }
      }
    }

    return results;
  };
}

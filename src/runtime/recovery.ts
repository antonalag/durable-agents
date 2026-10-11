import type { ExecutionRun, OutcomeRecord, RunRecoveredEvent, RunFailedEvent } from '../core/types.js';
import { DurableError } from '../errors.js';
import type { JournalStore } from '../stores/interface.js';
import { DurableContextImpl } from './context.js';
import { EventBus } from './event-bus.js';
import { Heartbeat } from './heartbeat.js';
import type { RunLifecycleState, TerminationReason } from './lifecycle.js';
import { installStepGovernance } from './step-governance.js';
import type { WorkflowFn } from './workflow.js';

function isFenced(error: unknown): boolean {
  return error instanceof DurableError && error.code === 'FENCED';
}

/**
 * Enforces the opt-in workflow-version compatibility matrix before any replay
 * cursor is built or any step runs. Throws DurableError('INCOMPATIBLE_RECOVERY')
 * when the persisted and current tokens disagree, including the asymmetric
 * cases where only one side declares a version:
 *
 *   persisted \ current | undefined        | defined
 *   --------------------|------------------|-----------------------------
 *   undefined           | allow (legacy)   | reject
 *   defined             | reject           | allow iff equal, else reject
 *
 * Call this before listSteps/cursor construction and before marking any state,
 * so a rejection leaves the run untouched (recovering/stale) and re-drivable.
 */
export function assertRecoveryCompatible(
  runId: string,
  persistedVersion: string | undefined,
  currentVersion: string | undefined,
): void {
  if (persistedVersion === undefined && currentVersion === undefined) {
    return;
  }
  if (persistedVersion === currentVersion) {
    return;
  }
  const persisted = persistedVersion ?? '(none)';
  const current = currentVersion ?? '(none)';
  throw new DurableError(
    'INCOMPATIBLE_RECOVERY',
    `Run ${runId} cannot be recovered: persisted workflowVersion ${persisted} ` +
      `is incompatible with the current workflowVersion ${current}. No steps were ` +
      `replayed or re-executed. Recover with a matching workflow version, or discard the run.`,
  );
}

export class RecoveryEngine {
  constructor(
    private store: JournalStore,
    private eventBus: EventBus,
    private staleTimeoutMs: number,
  ) {}

  async detectStaleRuns(): Promise<ExecutionRun[]> {
    return this.store.findStaleRuns(this.staleTimeoutMs);
  }

  async recover<TInput, TOutput>(
    runId: string,
    fn: WorkflowFn<TInput, TOutput>,
    input: TInput,
    generation: number,
    currentWorkflowVersion?: string,
  ): Promise<TOutput> {
    const run = await this.store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    // Gate recovery on version compatibility before any cursor is built, any
    // heartbeat starts, or any step runs. A rejection here leaves the claimed
    // run in 'recovering' with no terminal write, so it stays re-drivable once
    // a compatible workflow version is deployed.
    assertRecoveryCompatible(runId, run.config.workflowVersion, currentWorkflowVersion);

    const steps = await this.store.listSteps(runId);

    const replayCursor = new Map<string, OutcomeRecord>();
    let lastCompletedSequence = -1;
    const stepsToHeal: string[] = [];

    for (const step of steps) {
      const outcomes = await this.store.listOutcomes(step.stepId);
      for (const outcome of outcomes) {
        replayCursor.set(outcome.operationKey, outcome);
      }
      if (outcomes.length > 0) {
        if (step.sequence > lastCompletedSequence) {
          lastCompletedSequence = step.sequence;
        }
        if (step.status === 'running') {
          stepsToHeal.push(step.stepId);
        }
      }
    }

    let initialCost = 0;
    for (const outcome of replayCursor.values()) {
      initialCost += outcome.tokens.costUsd;
    }

    const heartbeatInterval = run.config.heartbeatIntervalMs ?? 10_000;
    const heartbeat = new Heartbeat(this.store, runId, heartbeatInterval, generation, this.eventBus);

    // Aborting on fence unwinds in-flight work via the signal the context observes.
    const abortController = new AbortController();

    const ctx = new DurableContextImpl({
      run,
      store: this.store,
      mode: 'replay',
      replayCursor,
      eventBus: this.eventBus,
      signal: abortController.signal,
      generation,
    });

    // Recovery is governed by the same rules as normal execution. The loaded
    // run is the activeRun, so totals.steps/totals.cost start at their persisted
    // pre-crash values; the seam accumulates fresh recovery steps on top.
    const lifecycle: RunLifecycleState = { phase: 'running', summaryStepAllowed: true };
    const requestGracefulStop = (reason: TerminationReason): void => {
      if (lifecycle.phase === 'running') {
        lifecycle.phase = 'stopping';
        lifecycle.terminationReason = reason;
      }
    };

    installStepGovernance({
      ctx,
      store: this.store,
      budgetConfig: run.config.budget,
      loopConfig: run.config.loopDetection,
      eventBus: this.eventBus,
      lifecycle,
      activeRun: run,
      initialRunningCost: initialCost,
      startTime: Date.now(),
      requestGracefulStop,
    });

    heartbeat.start();

    try {
      const result = await fn(ctx, input);

      for (const stepId of stepsToHeal) {
        await this.store.updateStep(stepId, { status: 'completed', completedAt: new Date() }, generation);
      }

      await this.store.updateRun(runId, {
        status: 'completed',
        totals: {
          ...run.totals,
          recoveryCount: run.totals.recoveryCount + 1,
        },
      }, generation);

      this.eventBus.emit('run:recovered', {
        type: 'run:recovered',
        timestamp: new Date(),
        runId,
        recoveredFromStep: lastCompletedSequence + 1,
        totalStepsRecovered: replayCursor.size,
      } satisfies RunRecoveredEvent);

      heartbeat.stop();
      return result;
    } catch (error: unknown) {
      heartbeat.stop();

      // Fenced means a higher-generation worker owns the run now. Yield to it:
      // abort, but write no terminal state and emit no run:failed.
      if (isFenced(error)) {
        abortController.abort();
        throw error;
      }

      // A graceful stop (budget/loop) aborts through the same AbortError path as
      // normal execution; it is a controlled stop, not a failure, so it writes a
      // terminal 'terminated' state rather than 'failed'.
      if (
        (error instanceof Error && error.name === 'AbortError') ||
        lifecycle.phase === 'terminated' ||
        lifecycle.phase === 'stopping'
      ) {
        const reason = lifecycle.terminationReason ?? 'budget_exceeded';
        try {
          await this.store.updateRun(runId, {
            status: 'terminated',
            totals: { ...run.totals, recoveryCount: run.totals.recoveryCount + 1 },
            metadata: { ...run.metadata, terminationReason: reason },
          }, generation);
        } catch (writeError) {
          if (isFenced(writeError)) {
            abortController.abort();
            throw writeError;
          }
          throw writeError;
        }
        return undefined as never;
      }

      await this.store.updateRun(runId, { status: 'failed' }, generation);

      this.eventBus.emit('run:failed', {
        type: 'run:failed',
        timestamp: new Date(),
        runId,
        error: error instanceof Error ? error : new Error(String(error)),
        lastCompletedStep: lastCompletedSequence >= 0 ? lastCompletedSequence : undefined,
      } satisfies RunFailedEvent);

      throw error;
    }
  }
}

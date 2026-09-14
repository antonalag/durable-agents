import type { ExecutionRun, OutcomeRecord, RunRecoveredEvent, RunFailedEvent } from '../core/types.js';
import { DurableError } from '../errors.js';
import type { JournalStore } from '../stores/interface.js';
import { DurableContextImpl } from './context.js';
import { EventBus } from './event-bus.js';
import { Heartbeat } from './heartbeat.js';
import type { WorkflowFn } from './workflow.js';

function isFenced(error: unknown): boolean {
  return error instanceof DurableError && error.code === 'FENCED';
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
  ): Promise<TOutput> {
    const run = await this.store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

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
          cost: initialCost,
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

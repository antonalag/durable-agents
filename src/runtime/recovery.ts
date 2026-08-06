import type { ExecutionRun, OutcomeRecord, RunRecoveredEvent, RunFailedEvent } from '../core/types.js';
import type { JournalStore } from '../stores/interface.js';
import { DurableContextImpl } from './context.js';
import { EventBus } from './event-bus.js';
import { Heartbeat } from './heartbeat.js';
import type { WorkflowFn } from './workflow.js';

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
  ): Promise<TOutput> {
    const run = await this.store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    const steps = await this.store.listSteps(runId);

    const replayCursor = new Map<string, OutcomeRecord>();
    let lastCompletedSequence = -1;

    for (const step of steps) {
      if (step.status === 'completed') {
        const outcomes = await this.store.listOutcomes(step.stepId);
        for (const outcome of outcomes) {
          replayCursor.set(outcome.operationKey, outcome);
        }
        if (step.sequence > lastCompletedSequence) {
          lastCompletedSequence = step.sequence;
        }
      }
    }

    const heartbeatInterval = run.config.heartbeatIntervalMs ?? 10_000;
    const heartbeat = new Heartbeat(this.store, runId, heartbeatInterval);

    const ctx = new DurableContextImpl({
      run,
      store: this.store,
      mode: 'replay',
      replayCursor,
      eventBus: this.eventBus,
      signal: new AbortController().signal,
    });

    heartbeat.start();

    try {
      const result = await fn(ctx, input);

      await this.store.updateRun(runId, {
        status: 'completed',
        totals: {
          ...run.totals,
          recoveryCount: run.totals.recoveryCount + 1,
        },
      });

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

      await this.store.updateRun(runId, { status: 'failed' });

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

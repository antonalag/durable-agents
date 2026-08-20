import { randomUUID } from 'node:crypto';
import type {
  ExecutionRun,
  OutcomeRecord,
  StepStartedEvent,
  StepCompletedEvent,
  TokenCost,
} from '../core/types.js';
import type { JournalStore } from '../stores/interface.js';
import { computeOperationKey } from '../serialization/operation-key.js';
import type { EventBus } from './event-bus.js';

export type ContextMode = 'fresh' | 'replay';

export interface DurableContextOptions {
  run: ExecutionRun;
  store: JournalStore;
  mode: ContextMode;
  replayCursor: Map<string, OutcomeRecord>;
  eventBus: EventBus;
  signal: AbortSignal;
}

export class DurableContextImpl {
  readonly run: ExecutionRun;
  readonly signal: AbortSignal;

  private sequence = 0;
  private mode: ContextMode;
  private replayCursor: Map<string, OutcomeRecord>;
  private store: JournalStore;
  private eventBus: EventBus;

  constructor(opts: DurableContextOptions) {
    this.run = opts.run;
    this.signal = opts.signal;
    this.mode = opts.mode;
    this.replayCursor = opts.replayCursor;
    this.store = opts.store;
    this.eventBus = opts.eventBus;
  }

  get currentSequence(): number {
    return this.sequence;
  }

  async step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    if (this.signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const operationKey = computeOperationKey(this.run.runId, name, this.sequence);

    const cached = this.replayCursor.get(operationKey);
    if (cached) {
      this.sequence++;
      return cached.result as T;
    }

    const stepId = randomUUID();
    const now = new Date();
    const zeroCost: TokenCost = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

    await this.store.createStep({
      stepId,
      runId: this.run.runId,
      nodeName: name,
      sequence: this.sequence,
      status: 'running',
      startedAt: now,
      cost: zeroCost,
      attempt: 1,
    });

    this.eventBus.emit('step:started', {
      type: 'step:started',
      timestamp: now,
      runId: this.run.runId,
      stepId,
      nodeName: name,
      sequence: this.sequence,
    } satisfies StepStartedEvent);

    const startMs = Date.now();

    try {
      const result = await fn();
      const durationMs = Date.now() - startMs;

      await this.store.recordOutcome({
        outcomeId: randomUUID(),
        stepId,
        operationType: 'custom',
        operationKey,
        result,
        tokens: zeroCost,
        durationMs,
        recordedAt: new Date(),
      });

      await this.store.updateStep(stepId, {
        status: 'completed',
        completedAt: new Date(),
      });

      this.eventBus.emit('step:completed', {
        type: 'step:completed',
        timestamp: new Date(),
        runId: this.run.runId,
        stepId,
        nodeName: name,
        sequence: this.sequence,
        cost: zeroCost,
        durationMs,
      } satisfies StepCompletedEvent);

      this.sequence++;
      return result;
    } catch (error) {
      await this.store.updateStep(stepId, {
        status: 'failed',
        completedAt: new Date(),
      });
      throw error;
    }
  }

  async parallel<T>(steps: Array<{ name: string; fn: () => T | Promise<T> }>): Promise<T[]> {
    if (this.signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const seqNumbers = steps.map((_, i) => this.sequence + i);
    this.sequence += steps.length;

    const promises = steps.map((step, i) => {
      const seq = seqNumbers[i];
      const operationKey = computeOperationKey(this.run.runId, step.name, seq);

      const cached = this.replayCursor.get(operationKey);
      if (cached) {
        return Promise.resolve(cached.result as T);
      }

      return this.executeParallelStep(step, seq, operationKey);
    });

    const settled = await Promise.allSettled(promises);

    const firstRejection = settled.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    if (firstRejection) {
      throw firstRejection.reason;
    }

    return settled.map(
      (r) => (r as PromiseFulfilledResult<T>).value,
    );
  }

  private async executeParallelStep<T>(
    step: { name: string; fn: () => T | Promise<T> },
    seq: number,
    operationKey: string,
  ): Promise<T> {
    const stepId = randomUUID();
    const now = new Date();
    const zeroCost: TokenCost = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

    await this.store.createStep({
      stepId,
      runId: this.run.runId,
      nodeName: step.name,
      sequence: seq,
      status: 'running',
      startedAt: now,
      cost: zeroCost,
      attempt: 1,
    });

    this.eventBus.emit('step:started', {
      type: 'step:started',
      timestamp: now,
      runId: this.run.runId,
      stepId,
      nodeName: step.name,
      sequence: seq,
    } satisfies StepStartedEvent);

    const startMs = Date.now();

    try {
      const result = await step.fn();
      const durationMs = Date.now() - startMs;

      await this.store.recordOutcome({
        outcomeId: randomUUID(),
        stepId,
        operationType: 'custom',
        operationKey,
        result,
        tokens: zeroCost,
        durationMs,
        recordedAt: new Date(),
      });

      await this.store.updateStep(stepId, {
        status: 'completed',
        completedAt: new Date(),
      });

      this.eventBus.emit('step:completed', {
        type: 'step:completed',
        timestamp: new Date(),
        runId: this.run.runId,
        stepId,
        nodeName: step.name,
        sequence: seq,
        cost: zeroCost,
        durationMs,
      } satisfies StepCompletedEvent);

      return result;
    } catch (error) {
      await this.store.updateStep(stepId, {
        status: 'failed',
        completedAt: new Date(),
      });
      throw error;
    }
  }

  async idempotent<T>(operationKey: string, fn: () => T | Promise<T>): Promise<T> {
    const existing = await this.store.getOutcomeByKey(operationKey);
    if (existing) {
      return existing.result as T;
    }

    const stepId = randomUUID();
    const now = new Date();
    const zeroCost: TokenCost = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

    await this.store.createStep({
      stepId,
      runId: this.run.runId,
      nodeName: `idempotent:${operationKey}`,
      sequence: -1,
      status: 'running',
      startedAt: now,
      cost: zeroCost,
      attempt: 1,
    });

    const startMs = Date.now();
    const result = await fn();
    const durationMs = Date.now() - startMs;

    await this.store.recordOutcome({
      outcomeId: randomUUID(),
      stepId,
      operationType: 'custom',
      operationKey,
      result,
      tokens: zeroCost,
      durationMs,
      recordedAt: new Date(),
    });

    await this.store.updateStep(stepId, {
      status: 'completed',
      completedAt: new Date(),
    });

    return result;
  }
}

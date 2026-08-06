import type { ExecutionRun, RunConfig, RunStartedEvent, RunCompletedEvent, RunFailedEvent } from '../core/types.js';
import type { JournalStore } from '../stores/interface.js';
import { DurableContextImpl } from './context.js';
import { EventBus } from './event-bus.js';
import { Heartbeat } from './heartbeat.js';
import { RecoveryEngine } from './recovery.js';

export interface DurableWorkflowOptions {
  store: JournalStore;
  heartbeatIntervalMs?: number;
  staleTimeoutMs?: number;
  autoRecover?: boolean;
  eventBus?: EventBus;
}

export type WorkflowFn<TInput, TOutput> = (ctx: DurableContextImpl, input: TInput) => Promise<TOutput>;

export class DurableWorkflow<TInput, TOutput> {
  readonly name: string;
  readonly eventBus: EventBus;

  private fn: WorkflowFn<TInput, TOutput>;
  private store: JournalStore;
  private heartbeatIntervalMs: number;
  private staleTimeoutMs: number;

  constructor(name: string, fn: WorkflowFn<TInput, TOutput>, opts: DurableWorkflowOptions) {
    const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 10_000;
    const staleTimeoutMs = opts.staleTimeoutMs ?? 30_000;

    if (heartbeatIntervalMs >= staleTimeoutMs) {
      throw new Error(
        `heartbeatIntervalMs (${heartbeatIntervalMs}) must be less than staleTimeoutMs (${staleTimeoutMs})`,
      );
    }

    this.name = name;
    this.fn = fn;
    this.store = opts.store;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.staleTimeoutMs = staleTimeoutMs;
    this.eventBus = opts.eventBus ?? new EventBus();

    if (opts.autoRecover) {
      queueMicrotask(() => void this.recoverStaleRuns());
    }
  }

  async run(input: TInput, options?: { signal?: AbortSignal }): Promise<TOutput> {
    const signal = options?.signal ?? new AbortController().signal;

    const config: RunConfig = {
      name: this.name,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      staleTimeoutMs: this.staleTimeoutMs,
      metadata: { input },
    };

    const run: ExecutionRun = await this.store.createRun(config);

    const heartbeat = new Heartbeat(this.store, run.runId, this.heartbeatIntervalMs);
    heartbeat.start();

    this.eventBus.emit('run:started', {
      type: 'run:started',
      timestamp: new Date(),
      runId: run.runId,
      config,
    } satisfies RunStartedEvent);

    const ctx = new DurableContextImpl({
      run,
      store: this.store,
      mode: 'fresh',
      replayCursor: new Map(),
      eventBus: this.eventBus,
      signal,
    });

    try {
      const result = await this.fn(ctx, input);

      await this.store.updateRun(run.runId, { status: 'completed', totals: run.totals });

      this.eventBus.emit('run:completed', {
        type: 'run:completed',
        timestamp: new Date(),
        runId: run.runId,
        result,
        totals: run.totals,
      } satisfies RunCompletedEvent);

      heartbeat.stop();
      return result;
    } catch (error: unknown) {
      heartbeat.stop();

      if (error instanceof Error && error.name === 'AbortError') {
        return undefined as never;
      }

      await this.store.updateRun(run.runId, { status: 'failed' });

      this.eventBus.emit('run:failed', {
        type: 'run:failed',
        timestamp: new Date(),
        runId: run.runId,
        error: error instanceof Error ? error : new Error(String(error)),
      } satisfies RunFailedEvent);

      throw error;
    }
  }

  private async recoverStaleRuns(): Promise<void> {
    const recoveryEngine = new RecoveryEngine(this.store, this.eventBus, this.staleTimeoutMs);
    const staleRuns = await recoveryEngine.detectStaleRuns();

    for (const run of staleRuns) {
      if (run.config.name !== this.name) continue;
      try {
        const input = run.metadata?.input as TInput;
        await recoveryEngine.recover(run.runId, this.fn, input);
      } catch {
        // Failure isolation: RecoveryEngine already marks run as failed and emits run:failed.
        // Continue recovering remaining stale runs.
      }
    }
  }
}

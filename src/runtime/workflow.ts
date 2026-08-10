import { createHash } from 'node:crypto';
import type {
  BudgetConfig,
  BudgetWarningEvent,
  BudgetExceededEvent,
  ExecutionRun,
  LoopConfig,
  LoopDetectedEvent,
  RunConfig,
  RunStartedEvent,
  RunCompletedEvent,
  RunFailedEvent,
} from '../core/types.js';
import type { JournalStore } from '../stores/interface.js';
import { checkBudget } from './budget.js';
import { DurableContextImpl } from './context.js';
import { EventBus } from './event-bus.js';
import { Heartbeat } from './heartbeat.js';
import { detectLoop, type StepRecord } from './loop-detector.js';
import { RecoveryEngine } from './recovery.js';

export type RunPhase = 'running' | 'stopping' | 'terminated';

export type TerminationReason = 'budget_exceeded' | 'loop_detected' | 'kill_switch';

export interface RunLifecycleState {
  phase: RunPhase;
  terminationReason?: TerminationReason;
  summaryStepAllowed: boolean;
}

export const SUMMARY_STEP_TIMEOUT_MS = 30_000;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Summary step timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface DurableWorkflowOptions {
  store: JournalStore;
  heartbeatIntervalMs?: number;
  staleTimeoutMs?: number;
  autoRecover?: boolean;
  eventBus?: EventBus;
  budget?: BudgetConfig;
  loopDetection?: LoopConfig;
}

export type WorkflowFn<TInput, TOutput> = (ctx: DurableContextImpl, input: TInput) => Promise<TOutput>;

function composeSignals(external: AbortSignal, internal: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  external.addEventListener('abort', onAbort, { once: true });
  internal.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

function hashResult(result: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(result)).digest('hex');
  } catch {
    return '';
  }
}

export class DurableWorkflow<TInput, TOutput> {
  readonly name: string;
  readonly eventBus: EventBus;

  private fn: WorkflowFn<TInput, TOutput>;
  private store: JournalStore;
  private heartbeatIntervalMs: number;
  private staleTimeoutMs: number;
  private budgetConfig: BudgetConfig | undefined;
  private loopConfig: LoopConfig | undefined;
  private activeRuns = new Map<string, AbortController>();
  private lifecycleStates = new Map<string, RunLifecycleState>();

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
    this.budgetConfig = opts.budget;
    this.loopConfig = opts.loopDetection;
    this.eventBus = opts.eventBus ?? new EventBus();

    if (opts.autoRecover) {
      queueMicrotask(() => void this.recoverStaleRuns());
    }
  }

  async run(input: TInput, options?: { signal?: AbortSignal }): Promise<TOutput> {
    const abortController = new AbortController();
    const signal = options?.signal
      ? composeSignals(options.signal, abortController.signal)
      : abortController.signal;

    const lifecycle: RunLifecycleState = { phase: 'running', summaryStepAllowed: true };

    const config: RunConfig = {
      name: this.name,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      staleTimeoutMs: this.staleTimeoutMs,
      budget: this.budgetConfig,
      loopDetection: this.loopConfig,
      metadata: { input },
    };

    const run: ExecutionRun = await this.store.createRun(config);

    this.activeRuns.set(run.runId, abortController);
    this.lifecycleStates.set(run.runId, lifecycle);

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

    const originalStep = ctx.step.bind(ctx);
    const stepHistory: StepRecord[] = [];
    const startTime = Date.now();
    const warningsEmitted = new Set<string>();
    const requestGracefulStop = DurableWorkflow.createGracefulStopRequester(lifecycle);

    ctx.step = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
      // Pre-step: budget check
      if (this.budgetConfig) {
        const elapsed = Date.now() - startTime;
        const budgetResult = checkBudget({
          totals: run.totals,
          elapsedMs: elapsed,
          config: this.budgetConfig,
        });

        if (budgetResult.status === 'warning' && budgetResult.triggeredBy && !warningsEmitted.has(budgetResult.triggeredBy)) {
          warningsEmitted.add(budgetResult.triggeredBy);
          this.eventBus.emit('budget:warning', {
            type: 'budget:warning',
            timestamp: new Date(),
            runId: run.runId,
            currentCost: run.totals.cost,
            budgetLimit: this.budgetConfig.maxCostUsd ?? 0,
            percentUsed: budgetResult.percentUsed,
          } satisfies BudgetWarningEvent);
        }

        if (budgetResult.status === 'exceeded') {
          this.eventBus.emit('budget:exceeded', {
            type: 'budget:exceeded',
            timestamp: new Date(),
            runId: run.runId,
            currentCost: run.totals.cost,
            budgetLimit: this.budgetConfig.maxCostUsd ?? 0,
            action: 'graceful_stop',
          } satisfies BudgetExceededEvent);
          requestGracefulStop('budget_exceeded');
        }
      }

      // Phase gate: lifecycle stopping/terminated
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

      // Execute step
      const result = await originalStep(name, fn);

      run.totals.steps++;

      // Post-step: loop detection
      if (this.loopConfig) {
        stepHistory.push({
          nodeName: name,
          sequence: run.totals.steps,
          outputHash: hashResult(result),
        });

        const loopResult = detectLoop(stepHistory, this.loopConfig);
        if (loopResult.detected) {
          this.eventBus.emit('loop:detected', {
            type: 'loop:detected',
            timestamp: new Date(),
            runId: run.runId,
            loopType: loopResult.loopType!,
            detectedAtStep: run.totals.steps,
            repetitions: loopResult.repetitions!,
          } satisfies LoopDetectedEvent);

          if (loopResult.action === 'graceful_stop') {
            requestGracefulStop('loop_detected');
          }
        }
      }

      return result;
    };

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

      return result;
    } catch (error: unknown) {
      // Kill switch: abort was triggered externally via terminate()
      // terminate() already updates the store, so just return
      if (error instanceof Error && error.name === 'AbortError') {
        if (lifecycle.terminationReason === 'kill_switch') {
          // Store already updated by terminate() — no action needed
          return undefined as never;
        }
        // Graceful stop completed: phase transitioned to terminated and threw AbortError
        if (lifecycle.phase === 'terminated' || lifecycle.phase === 'stopping') {
          const reason = lifecycle.terminationReason ?? 'budget_exceeded';
          await this.store.updateRun(run.runId, {
            status: 'terminated',
            metadata: { ...run.metadata, terminationReason: reason },
          });
          return undefined as never;
        }
        return undefined as never;
      }

      // Graceful stop completed or timed out — mark terminated
      if (lifecycle.phase === 'terminated' || lifecycle.phase === 'stopping') {
        const reason = lifecycle.terminationReason ?? 'budget_exceeded';
        await this.store.updateRun(run.runId, {
          status: 'terminated',
          metadata: { ...run.metadata, terminationReason: reason },
        });
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
    } finally {
      this.activeRuns.delete(run.runId);
      this.lifecycleStates.delete(run.runId);
      heartbeat.stop();
    }
  }

  /** Creates a function that transitions a lifecycle state to 'stopping' phase. */
  static createGracefulStopRequester(lifecycle: RunLifecycleState) {
    return (reason: TerminationReason) => {
      if (lifecycle.phase === 'running') {
        lifecycle.phase = 'stopping';
        lifecycle.terminationReason = reason;
      }
    };
  }

  terminate(runId: string, reason: string): void {
    const abortController = this.activeRuns.get(runId);
    if (!abortController) {
      throw new Error(`Run ${runId} is not active`);
    }

    const lifecycle = this.lifecycleStates.get(runId);
    if (lifecycle) {
      lifecycle.phase = 'terminated';
      lifecycle.terminationReason = 'kill_switch';
    }

    abortController.abort();
    this.activeRuns.delete(runId);
    this.lifecycleStates.delete(runId);
    void this.store.updateRun(runId, {
      status: 'terminated',
      metadata: { terminationReason: 'kill_switch', terminationDetail: reason },
    });
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

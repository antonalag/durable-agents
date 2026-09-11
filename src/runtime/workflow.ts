import { createHash } from 'node:crypto';
import type {
  BudgetConfig,
  BudgetWarningEvent,
  BudgetExceededEvent,
  EventMap,
  ExecutionRun,
  LoopConfig,
  LoopDetectedEvent,
  RunConfig,
  RunStartedEvent,
  RunCompletedEvent,
  RunFailedEvent,
} from '../core/types.js';
import { DurableError } from '../errors.js';
import { computeOperationKey } from '../serialization/operation-key.js';
import type { JournalStore } from '../stores/interface.js';
import { checkBudget } from './budget.js';
import { validateRunConfig } from './config-validation.js';
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
  /** Fencing generation each active run holds; the source of truth for terminate(). */
  private runGenerations = new Map<string, number>();

  constructor(name: string, fn: WorkflowFn<TInput, TOutput>, opts: DurableWorkflowOptions) {
    const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 10_000;
    const staleTimeoutMs = opts.staleTimeoutMs ?? 30_000;

    validateRunConfig({
      name,
      heartbeatIntervalMs,
      staleTimeoutMs,
      budget: opts.budget,
      loopDetection: opts.loopDetection,
    });

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

  on<K extends keyof EventMap>(type: K, handler: (event: EventMap[K]) => void): void {
    this.eventBus.on(type, handler);
  }

  off<K extends keyof EventMap>(type: K, handler: (event: EventMap[K]) => void): void {
    this.eventBus.off(type, handler);
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
    // A normally-started run owns generation 0; a recovery claim advances it.
    const generation = run.recoveryGeneration;
    await this.store.updateRun(run.runId, { status: 'running' }, generation);
    const activeRun: ExecutionRun = { ...run, status: 'running' };

    this.activeRuns.set(activeRun.runId, abortController);
    this.lifecycleStates.set(activeRun.runId, lifecycle);
    this.runGenerations.set(activeRun.runId, generation);

    const heartbeat = new Heartbeat(this.store, activeRun.runId, this.heartbeatIntervalMs, generation, this.eventBus);
    heartbeat.start();

    this.eventBus.emit('run:started', {
      type: 'run:started',
      timestamp: new Date(),
      runId: activeRun.runId,
      config,
    } satisfies RunStartedEvent);

    const ctx = new DurableContextImpl({
      run: activeRun,
      store: this.store,
      mode: 'fresh',
      replayCursor: new Map(),
      eventBus: this.eventBus,
      signal,
      generation,
    });

    const originalStep = ctx.step.bind(ctx);
    const stepHistory: StepRecord[] = [];
    const startTime = Date.now();
    const warningsEmitted = new Set<string>();
    const requestGracefulStop = DurableWorkflow.createGracefulStopRequester(lifecycle);
    let runningCost = 0;

    const runBudgetCheckAndEmit = (): void => {
      if (!this.budgetConfig) return;

      const budgetResult = checkBudget({
        totals: activeRun.totals,
        elapsedMs: Date.now() - startTime,
        config: this.budgetConfig,
      });

      if (budgetResult.status === 'warning' && budgetResult.triggeredBy && !warningsEmitted.has(budgetResult.triggeredBy)) {
        warningsEmitted.add(budgetResult.triggeredBy);
        this.eventBus.emit('budget:warning', {
          type: 'budget:warning',
          timestamp: new Date(),
          runId: activeRun.runId,
          currentCost: activeRun.totals.cost,
          budgetLimit: this.budgetConfig.maxCostUsd ?? 0,
          percentUsed: budgetResult.percentUsed,
        } satisfies BudgetWarningEvent);
      }

      if (budgetResult.status === 'exceeded') {
        this.eventBus.emit('budget:exceeded', {
          type: 'budget:exceeded',
          timestamp: new Date(),
          runId: activeRun.runId,
          currentCost: activeRun.totals.cost,
          budgetLimit: this.budgetConfig.maxCostUsd ?? 0,
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

      activeRun.totals.steps++;

      const operationKey = computeOperationKey(activeRun.runId, name, seqBeforeStep);
      const outcome = await this.store.getOutcomeByKey(operationKey);
      if (outcome) {
        runningCost += outcome.tokens.costUsd;
        activeRun.totals.cost = runningCost;
      }

      if (this.loopConfig) {
        stepHistory.push({
          nodeName: name,
          sequence: activeRun.totals.steps,
          outputHash: hashResult(result),
        });

        const loopResult = detectLoop(stepHistory, this.loopConfig);
        if (loopResult.detected) {
          this.eventBus.emit('loop:detected', {
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

      return result;
    };

    const originalParallel = ctx.parallel.bind(ctx);

    ctx.parallel = async <T>(
      steps: Array<{ name: string; fn: () => T | Promise<T> }>,
    ): Promise<T[]> => {
      runBudgetCheckAndEmit();

      if (lifecycle.phase === 'terminated' || lifecycle.phase === 'stopping') {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }

      const seqBeforeGroup = ctx.currentSequence;
      const results = await originalParallel(steps);

      activeRun.totals.steps += steps.length;

      for (let i = 0; i < steps.length; i++) {
        const key = computeOperationKey(activeRun.runId, steps[i].name, seqBeforeGroup + i);
        if (!ctx.wasReplayed(key)) {
          const outcome = await this.store.getOutcomeByKey(key);
          if (outcome) {
            runningCost += outcome.tokens.costUsd;
          }
        }
      }
      activeRun.totals.cost = runningCost;

      runBudgetCheckAndEmit();

      if (this.loopConfig) {
        const stepsBase = activeRun.totals.steps - steps.length;
        for (let i = 0; i < steps.length; i++) {
          stepHistory.push({
            nodeName: steps[i].name,
            sequence: stepsBase + i + 1,
            outputHash: hashResult(results[i]),
          });
        }

        const loopResult = detectLoop(stepHistory, this.loopConfig);
        if (loopResult.detected) {
          this.eventBus.emit('loop:detected', {
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

    try {
      const result = await this.fn(ctx, input);

      await this.store.updateRun(activeRun.runId, { status: 'completed', totals: activeRun.totals }, generation);

      this.eventBus.emit('run:completed', {
        type: 'run:completed',
        timestamp: new Date(),
        runId: activeRun.runId,
        result,
        totals: activeRun.totals,
      } satisfies RunCompletedEvent);

      return result;
    } catch (error: unknown) {
      // Fenced means another worker reclaimed this run at a higher generation.
      // That is not a failure: yield to the winner, writing no terminal state
      // and emitting no run:failed.
      if (error instanceof DurableError && error.code === 'FENCED') {
        abortController.abort();
        return undefined as never;
      }

      // A terminal write below can itself be fenced if a reclaim races it, so
      // route those writes through this guard to yield cleanly instead of
      // letting a raw FENCED escape.
      const writeTerminal = async (
        updates: Parameters<JournalStore['updateRun']>[1],
      ): Promise<boolean> => {
        try {
          await this.store.updateRun(activeRun.runId, updates, generation);
          return true;
        } catch (writeError) {
          if (writeError instanceof DurableError && writeError.code === 'FENCED') {
            abortController.abort();
            return false;
          }
          throw writeError;
        }
      };

      // An AbortError here comes from terminate() (kill switch, already
      // persisted) or from a completed graceful stop that must be marked
      // terminated.
      if (error instanceof Error && error.name === 'AbortError') {
        if (lifecycle.terminationReason === 'kill_switch') {
          return undefined as never;
        }
        if (lifecycle.phase === 'terminated' || lifecycle.phase === 'stopping') {
          const reason = lifecycle.terminationReason ?? 'budget_exceeded';
          await writeTerminal({
            status: 'terminated',
            metadata: { ...activeRun.metadata, terminationReason: reason },
          });
          return undefined as never;
        }
        return undefined as never;
      }

      if (lifecycle.phase === 'terminated' || lifecycle.phase === 'stopping') {
        const reason = lifecycle.terminationReason ?? 'budget_exceeded';
        await writeTerminal({
          status: 'terminated',
          metadata: { ...activeRun.metadata, terminationReason: reason },
        });
        return undefined as never;
      }

      if (!(await writeTerminal({ status: 'failed' }))) {
        return undefined as never;
      }

      this.eventBus.emit('run:failed', {
        type: 'run:failed',
        timestamp: new Date(),
        runId: activeRun.runId,
        error: error instanceof Error ? error : new Error(String(error)),
      } satisfies RunFailedEvent);

      throw error;
    } finally {
      this.activeRuns.delete(activeRun.runId);
      this.lifecycleStates.delete(activeRun.runId);
      this.runGenerations.delete(activeRun.runId);
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

  async terminate(runId: string, reason: string): Promise<void> {
    const abortController = this.activeRuns.get(runId);
    if (!abortController) {
      throw new DurableError('RUN_TERMINATED', `Run ${runId} is not active`);
    }

    const lifecycle = this.lifecycleStates.get(runId);
    if (lifecycle) {
      lifecycle.phase = 'terminated';
      lifecycle.terminationReason = 'kill_switch';
    }

    // Use the generation THIS owner holds; never re-read it from the store, or
    // a worker that was reclaimed could legitimize a write against the new
    // owner's generation. It is set alongside the activeRuns entry, so its
    // absence for an active run is an internal inconsistency, not a gen-0 run.
    const generation = this.runGenerations.get(runId);
    if (generation === undefined) {
      throw new DurableError(
        'RUN_TERMINATED',
        `Run ${runId} is active but its held generation is unknown; refusing to terminate against an unverified generation`,
      );
    }

    try {
      // Persist termination before aborting: the store is the source of truth.
      await this.store.updateRun(runId, {
        status: 'terminated',
        metadata: { terminationReason: 'kill_switch', terminationDetail: reason },
      }, generation);
    } catch (error) {
      // Fenced or store failure: nothing was persisted. Release local state,
      // abort in-flight work, and propagate the error so the caller learns the
      // termination did not take effect.
      abortController.abort();
      this.activeRuns.delete(runId);
      this.lifecycleStates.delete(runId);
      this.runGenerations.delete(runId);
      throw error;
    }

    abortController.abort();
    this.activeRuns.delete(runId);
    this.lifecycleStates.delete(runId);
    this.runGenerations.delete(runId);
  }

  private async recoverStaleRuns(): Promise<void> {
    const recoveryEngine = new RecoveryEngine(this.store, this.eventBus, this.staleTimeoutMs);
    const staleRuns = await recoveryEngine.detectStaleRuns();

    for (const run of staleRuns) {
      if (run.config.name !== this.name) continue;

      const claim = await this.store.claimRunForRecovery(run.runId);
      if (!claim) continue;

      // A recovering run is owned entirely by RecoveryEngine.recover() and is
      // deliberately not registered in activeRuns/runGenerations, so terminate()
      // refuses it rather than writing against a generation it does not hold.
      try {
        const input = run.metadata?.input as TInput;
        await recoveryEngine.recover(claim.run.runId, this.fn, input, claim.generation);
      } catch {
        // Isolate failures: RecoveryEngine already handled its own terminal
        // state, so keep recovering the remaining stale runs.
      }
    }
  }
}

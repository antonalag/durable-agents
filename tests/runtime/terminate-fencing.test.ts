import { describe, it, expect, vi } from 'vitest';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { DurableError } from '../../src/errors.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type { ExecutionRun, RunFailedEvent } from '../../src/core/types.js';

const RUN_ID = 'run-123';

/**
 * A configurable in-memory-ish mock store. `terminalBehavior` decides how a
 * terminal `updateRun` (status completed/failed/terminated) resolves:
 *  - 'ok'     → succeeds
 *  - 'fenced' → throws DurableError('FENCED'), simulating this owner having been
 *               superseded by a higher-generation reclaim
 */
function createMockStore(terminalBehavior: 'ok' | 'fenced' = 'ok') {
  const now = new Date();
  const fakeRun: ExecutionRun = {
    runId: RUN_ID,
    status: 'running',
    config: { name: 'test-workflow' },
    metadata: {},
    totals: { cost: 0, tokens: 0, steps: 0, recoveryCount: 0 },
    createdAt: now,
    updatedAt: now,
    lastHeartbeat: now,
    recoveryGeneration: 0,
  };

  const isTerminal = (s: unknown) =>
    s === 'completed' || s === 'failed' || s === 'terminated';

  // Records only terminal-status writes that actually PERSISTED (resolved),
  // so a fenced (thrown) terminal write is never counted as persisted.
  const persistedTerminalStatuses: string[] = [];

  const store = {
    persistedTerminalStatuses,
    createRun: vi.fn().mockResolvedValue(fakeRun),
    updateRun: vi.fn().mockImplementation(async (_runId: string, updates: { status?: string }) => {
      if (terminalBehavior === 'fenced' && isTerminal(updates?.status)) {
        throw new DurableError('FENCED', 'superseded by a higher generation');
      }
      if (isTerminal(updates?.status)) {
        persistedTerminalStatuses.push(updates!.status!);
      }
      return { ...fakeRun, ...updates };
    }),
    getRun: vi.fn().mockResolvedValue(fakeRun),
    updateHeartbeat: vi.fn().mockResolvedValue(true),
    createStep: vi.fn().mockResolvedValue({
      stepId: 'step-1',
      runId: RUN_ID,
      nodeName: 'test',
      sequence: 0,
      status: 'running',
      startedAt: now,
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      attempt: 1,
    }),
    updateStep: vi.fn().mockResolvedValue({
      stepId: 'step-1',
      runId: RUN_ID,
      nodeName: 'test',
      sequence: 0,
      status: 'completed',
      startedAt: now,
      completedAt: now,
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      attempt: 1,
    }),
    recordOutcome: vi.fn().mockResolvedValue({
      outcomeId: 'outcome-1',
      stepId: 'step-1',
      operationType: 'custom',
      operationKey: 'key-1',
      result: null,
      tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      durationMs: 0,
      recordedAt: now,
    }),
    getOutcomeByKey: vi.fn().mockResolvedValue(null),
    getStep: vi.fn().mockResolvedValue(null),
    getOutcome: vi.fn().mockResolvedValue(null),
    listSteps: vi.fn().mockResolvedValue([]),
    listOutcomes: vi.fn().mockResolvedValue([]),
    listRuns: vi.fn().mockResolvedValue([]),
    findStaleRuns: vi.fn().mockResolvedValue([]),
    claimRunForRecovery: vi.fn().mockResolvedValue(null),
    deleteRun: vi.fn().mockResolvedValue(undefined),
    deleteRunsOlderThan: vi.fn().mockResolvedValue(0),
  };

  return store;
}

/**
 * Count of terminal-status writes that actually PERSISTED (the mock resolved).
 * A fenced terminal write throws, so it is never recorded here — this counts
 * durable effect, not attempts.
 */
function persistedTerminatedCount(
  store: ReturnType<typeof createMockStore>,
): number {
  return store.persistedTerminalStatuses.filter((s) => s === 'terminated').length;
}

/**
 * Gap #9 — a normal (non-recovery, generation 0) run whose terminal write is
 * fenced must yield cleanly (Req 9.16, 9.17): no run:failed, no thrown error,
 * no terminal state attributed to the fenced owner.
 */
describe('normal run yields cleanly when its terminal write is fenced', () => {
  it('a fenced updateRun(failed) does not emit run:failed and does not rethrow', async () => {
    const store = createMockStore('fenced');
    const eventBus = new EventBus();
    const failed: RunFailedEvent[] = [];
    eventBus.on('run:failed', (e) => failed.push(e));

    // fn throws a normal (non-FENCED) error, driving run() into the failure
    // branch where it attempts the terminal updateRun({status:'failed'}).
    const workflow = new DurableWorkflow(
      'test-workflow',
      async () => {
        throw new Error('workflow boom');
      },
      { store: store as unknown as JournalStore, eventBus },
    );

    // Yields: resolves to undefined rather than throwing the original error.
    await expect(workflow.run('input')).resolves.toBeUndefined();

    // No run:failed emitted for a fenced owner.
    expect(failed).toHaveLength(0);
    // The fenced terminal write was attempted but never persisted 'failed'
    // as a successful write (it threw). And no 'terminated' write happened here.
    expect(persistedTerminatedCount(store)).toBe(0);
  });
});

/**
 * Gap #10 — terminate() by an owner whose held generation has been superseded
 * (Req 9.26, 9.27, 9.29): the terminal write is rejected, so terminate() writes
 * no 'terminated', emits no run:failed, aborts local work, cleans local state,
 * and propagates DurableError('FENCED') to the caller.
 */
describe('terminate() by a fenced (stale-generation) owner', () => {
  it('propagates FENCED, persists no terminated state, emits no run:failed, and cleans local state', async () => {
    const store = createMockStore('fenced');
    const eventBus = new EventBus();
    const failed: RunFailedEvent[] = [];
    eventBus.on('run:failed', (e) => failed.push(e));

    let sawAbort = false;
    // Long-lived fn so the run stays active while we call terminate().
    const workflow = new DurableWorkflow(
      'test-workflow',
      async (ctx) => {
        ctx.signal.addEventListener('abort', () => {
          sawAbort = true;
        });
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            if (ctx.signal.aborted) {
              clearInterval(timer);
              resolve(undefined);
            }
          }, 5);
        });
        return 'never';
      },
      { store: store as unknown as JournalStore, eventBus },
    );

    const runPromise = workflow.run('input');
    // Let the run register itself as active.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The held generation (0) no longer matches the store's current generation,
    // so the terminal write throws FENCED and terminate() propagates it.
    await expect(workflow.terminate(RUN_ID, 'stop')).rejects.toSatisfy(
      (e: unknown) => e instanceof DurableError && e.code === 'FENCED',
    );

    // No 'terminated' persisted by the fenced owner; no run:failed emitted.
    expect(persistedTerminatedCount(store)).toBe(0);
    expect(failed).toHaveLength(0);

    // Local work aborted, so the run unwinds.
    expect(sawAbort).toBe(true);
    await runPromise.catch(() => {});

    // Local lifecycle cleaned up: a second terminate finds no active run.
    await expect(workflow.terminate(RUN_ID, 'again')).rejects.toThrow(
      /is not active/,
    );
  });
});

/**
 * Gap #11 (method level) — terminate() by the fencing winner (held generation
 * matches the store) persists 'terminated' and resolves (Req 9.27, contrast).
 */
describe('terminate() by the fencing winner', () => {
  it('persists terminated and resolves', async () => {
    const store = createMockStore('ok');
    const eventBus = new EventBus();

    const workflow = new DurableWorkflow(
      'test-workflow',
      async (ctx) => {
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            if (ctx.signal.aborted) {
              clearInterval(timer);
              resolve(undefined);
            }
          }, 5);
        });
        return 'never';
      },
      { store: store as unknown as JournalStore, eventBus },
    );

    const runPromise = workflow.run('input');
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(workflow.terminate(RUN_ID, 'stop')).resolves.toBeUndefined();

    // Exactly the winner's terminal write reached the store.
    expect(persistedTerminatedCount(store)).toBeGreaterThanOrEqual(1);

    await runPromise.catch(() => {});
  });
});

/**
 * Gap #13 — runGenerations invariant. If a run is active but its held
 * generation is unknown (internal inconsistency), terminate() must fail loudly
 * with RUN_TERMINATED rather than silently defaulting to generation 0 and
 * writing against an unverified generation.
 */
describe('terminate() refuses an active run with an unknown held generation', () => {
  it('throws RUN_TERMINATED (never defaults to generation 0) and persists no terminated write', async () => {
    const store = createMockStore('ok');
    const eventBus = new EventBus();

    const workflow = new DurableWorkflow(
      'test-workflow',
      async (ctx) => {
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            if (ctx.signal.aborted) {
              clearInterval(timer);
              resolve(undefined);
            }
          }, 5);
        });
        return 'never';
      },
      { store: store as unknown as JournalStore, eventBus },
    );

    const runPromise = workflow.run('input');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Force the inconsistent state: the run is still active, but its recorded
    // generation is missing. This is the guard's precondition — a state the
    // runtime treats as an internal invariant violation, not a gen-0 default.
    const internals = workflow as unknown as {
      runGenerations: Map<string, number>;
    };
    expect(internals.runGenerations.has(RUN_ID)).toBe(true);
    internals.runGenerations.delete(RUN_ID);

    await expect(workflow.terminate(RUN_ID, 'stop')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DurableError &&
        e.code === 'RUN_TERMINATED' &&
        /held generation is unknown/.test(e.message),
    );

    // Crucially, it did NOT fall back to generation 0 and write 'terminated'.
    expect(persistedTerminatedCount(store)).toBe(0);

    // Clean up the still-active run.
    const abortInternals = workflow as unknown as {
      activeRuns: Map<string, AbortController>;
    };
    abortInternals.activeRuns.get(RUN_ID)?.abort();
    await runPromise.catch(() => {});
  });
});

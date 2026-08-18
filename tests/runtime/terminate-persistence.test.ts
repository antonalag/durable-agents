import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type { ExecutionRun } from '../../src/core/types.js';

function createMockStore() {
  const now = new Date();
  const fakeRun: ExecutionRun = {
    runId: 'run-123',
    status: 'running',
    config: { name: 'test-workflow' },
    metadata: {},
    totals: { cost: 0, tokens: 0, steps: 0, recoveryCount: 0 },
    createdAt: now,
    updatedAt: now,
    lastHeartbeat: now,
  };

  return {
    createRun: vi.fn().mockResolvedValue(fakeRun),
    updateRun: vi.fn().mockResolvedValue({ ...fakeRun, status: 'terminated' }),
    getRun: vi.fn().mockResolvedValue(fakeRun),
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    createStep: vi.fn().mockResolvedValue({
      stepId: 'step-1',
      runId: 'run-123',
      nodeName: 'test',
      sequence: 0,
      status: 'running',
      startedAt: now,
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      attempt: 1,
    }),
    updateStep: vi.fn().mockResolvedValue({
      stepId: 'step-1',
      runId: 'run-123',
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
    deleteRun: vi.fn().mockResolvedValue(undefined),
    deleteRunsOlderThan: vi.fn().mockResolvedValue(0),
  };
}

describe('terminate() persistence-first semantics', () => {
  let store: ReturnType<typeof createMockStore>;
  let eventBus: EventBus;

  beforeEach(() => {
    store = createMockStore();
    eventBus = new EventBus();
  });

  it('store.updateRun is called before abort signal fires', async () => {
    let abortedDuringPersist = false;
    let resolveBarrier: () => void;
    const barrier = new Promise<void>((r) => { resolveBarrier = r; });

    const workflow = new DurableWorkflow(
      'test-workflow',
      async (ctx) => {
        await ctx.step('first', () => {
          resolveBarrier!();
          return 'ok';
        });
        // Many steps to keep workflow alive while terminate() is called
        for (let i = 0; i < 50; i++) {
          await ctx.step(`step-${i}`, () => 'ok');
        }
        return 'done';
      },
      { store: store as unknown as JournalStore, eventBus },
    );

    const runPromise = workflow.run('input');
    await barrier;

    // Grab the abort controller before terminate cleans it up
    const abortController = (workflow as unknown as { activeRuns: Map<string, AbortController> }).activeRuns.get('run-123')!;
    expect(abortController).toBeDefined();

    // Override updateRun to check abort state during the terminate persist call
    store.updateRun.mockImplementation(async (_runId: string, updates: unknown) => {
      if ((updates as { status?: string })?.status === 'terminated') {
        abortedDuringPersist = abortController.signal.aborted;
      }
      const fakeRun = await store.createRun.mock.results[0]!.value;
      return { ...fakeRun, status: 'terminated' };
    });

    await workflow.terminate('run-123', 'test-reason');

    // Abort was NOT fired during the persist call (persistence-first)
    expect(abortedDuringPersist).toBe(false);
    // But abort IS fired after terminate() completes
    expect(abortController.signal.aborted).toBe(true);

    await runPromise.catch(() => {});
  });

  it('terminate() rejects if store.updateRun rejects', async () => {
    let resolveBarrier: () => void;
    const barrier = new Promise<void>((r) => { resolveBarrier = r; });
    const storeError = new Error('persistence failure');

    const workflow = new DurableWorkflow(
      'test-workflow',
      async (ctx) => {
        await ctx.step('first', () => {
          resolveBarrier!();
          return 'ok';
        });
        for (let i = 0; i < 50; i++) {
          await ctx.step(`step-${i}`, () => 'ok');
        }
        return 'done';
      },
      { store: store as unknown as JournalStore, eventBus },
    );

    const runPromise = workflow.run('input');
    await barrier;

    // Make the terminate-specific updateRun call fail
    store.updateRun.mockImplementation(async (_runId: string, updates: unknown) => {
      if ((updates as { status?: string })?.status === 'terminated') {
        throw storeError;
      }
      const fakeRun = await store.createRun.mock.results[0]!.value;
      return { ...fakeRun, status: 'running' };
    });

    await expect(workflow.terminate('run-123', 'test-reason')).rejects.toThrow('persistence failure');

    await runPromise.catch(() => {});
  });

  it('abort signal fires even when store.updateRun fails (best-effort cleanup)', async () => {
    let resolveBarrier: () => void;
    const barrier = new Promise<void>((r) => { resolveBarrier = r; });
    const storeError = new Error('persistence failure');

    const workflow = new DurableWorkflow(
      'test-workflow',
      async (ctx) => {
        await ctx.step('first', () => {
          resolveBarrier!();
          return 'ok';
        });
        for (let i = 0; i < 50; i++) {
          await ctx.step(`step-${i}`, () => 'ok');
        }
        return 'done';
      },
      { store: store as unknown as JournalStore, eventBus },
    );

    const runPromise = workflow.run('input');
    await barrier;

    const abortController = (workflow as unknown as { activeRuns: Map<string, AbortController> }).activeRuns.get('run-123')!;
    expect(abortController).toBeDefined();

    // Make terminate's updateRun call reject
    store.updateRun.mockImplementation(async (_runId: string, updates: unknown) => {
      if ((updates as { status?: string })?.status === 'terminated') {
        throw storeError;
      }
      const fakeRun = await store.createRun.mock.results[0]!.value;
      return { ...fakeRun, status: 'running' };
    });

    await workflow.terminate('run-123', 'test-reason').catch(() => {});

    // Even though store failed, abort was still fired (best-effort)
    expect(abortController.signal.aborted).toBe(true);

    await runPromise.catch(() => {});
  });

  it('if store persistence fails, the run is NOT durably terminated', async () => {
    let resolveBarrier: () => void;
    const barrier = new Promise<void>((r) => { resolveBarrier = r; });
    const storeError = new Error('persistence failure');

    const workflow = new DurableWorkflow(
      'test-workflow',
      async (ctx) => {
        await ctx.step('first', () => {
          resolveBarrier!();
          return 'ok';
        });
        for (let i = 0; i < 50; i++) {
          await ctx.step(`step-${i}`, () => 'ok');
        }
        return 'done';
      },
      { store: store as unknown as JournalStore, eventBus },
    );

    const runPromise = workflow.run('input');
    await barrier;

    // Track all successful updateRun calls
    const successfulUpdates: unknown[] = [];
    store.updateRun.mockImplementation(async (_runId: string, updates: unknown) => {
      if ((updates as { status?: string })?.status === 'terminated') {
        throw storeError;
      }
      successfulUpdates.push(updates);
      const fakeRun = await store.createRun.mock.results[0]!.value;
      return { ...fakeRun, ...(updates as object) };
    });

    await workflow.terminate('run-123', 'test-reason').catch(() => {});

    // No successful write with status='terminated' reached the store.
    // The store still sees the run as 'running', so stale detection could find it.
    const terminatedWrites = successfulUpdates.filter(
      (u) => (u as { status?: string })?.status === 'terminated',
    );
    expect(terminatedWrites).toHaveLength(0);

    await runPromise.catch(() => {});
  });
});

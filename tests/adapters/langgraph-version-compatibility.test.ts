import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { DurableError } from '../../src/errors.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { RunConfig, Step } from '../../src/core/types.js';

vi.mock('../../src/adapters/peer-check.js', () => ({
  assertPeerDependency: vi.fn(),
}));

const { createDurableMiddleware } = await import('../../src/adapters/langgraph.js');

function isIncompatible(error: unknown): boolean {
  return error instanceof DurableError && error.code === 'INCOMPATIBLE_RECOVERY';
}

describe('LangGraph adapter honors workflow version compatibility', () => {
  let store: SqliteJournalStore;
  let eventBus: EventBus;

  beforeEach(() => {
    store = new SqliteJournalStore(':memory:');
    eventBus = new EventBus();
  });

  afterEach(() => {
    store.close();
  });

  async function seedStaleRun(config: RunConfig): Promise<string> {
    const staleRun = await store.createRun(config);
    await store.updateRun(staleRun.runId, { status: 'running' }, 0);

    const oldTime = new Date(Date.now() - 60_000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).db
      .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
      .run(oldTime, staleRun.runId);

    const step: Step = {
      stepId: 'stale-step-0',
      runId: staleRun.runId,
      nodeName: 'llm-call',
      sequence: 0,
      status: 'completed',
      startedAt: new Date(),
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      attempt: 1,
    };
    await store.createStep(step, 0);
    await store.recordOutcome(
      {
        outcomeId: 'stale-outcome-0',
        stepId: 'stale-step-0',
        operationType: 'llm_call',
        operationKey: computeOperationKey(staleRun.runId, 'llm-call', 0),
        result: { content: 'cached' },
        tokens: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        durationMs: 1,
        recordedAt: new Date(),
      },
      0,
    );
    return staleRun.runId;
  }

  it('rejects replay and leaves the stale run untouched when versions differ', async () => {
    const staleId = await seedStaleRun({ name: 'wf', workflowVersion: 'v1' });

    const mw = createDurableMiddleware({
      store,
      config: { name: 'wf', workflowVersion: 'v2', staleTimeoutMs: 30_000 },
      eventBus,
    });

    await expect(mw.beforeAgent!({ runId: '', config: { name: 'wf' } })).rejects.toSatisfy(
      isIncompatible,
    );

    // The stale run was not marked failed and no new run was created.
    const stale = await store.getRun(staleId);
    expect(stale!.status).toBe('running');
    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
  });

  it('rejects a versionless journal against a versioned adapter', async () => {
    const staleId = await seedStaleRun({ name: 'wf' });

    const mw = createDurableMiddleware({
      store,
      config: { name: 'wf', workflowVersion: 'v1', staleTimeoutMs: 30_000 },
      eventBus,
    });

    await expect(mw.beforeAgent!({ runId: '', config: { name: 'wf' } })).rejects.toSatisfy(
      isIncompatible,
    );

    const stale = await store.getRun(staleId);
    expect(stale!.status).toBe('running');
  });

  it('proceeds with replay when versions match', async () => {
    await seedStaleRun({ name: 'wf', workflowVersion: 'v3' });

    const mw = createDurableMiddleware({
      store,
      config: { name: 'wf', workflowVersion: 'v3', staleTimeoutMs: 30_000 },
      eventBus,
    });

    await expect(
      mw.beforeAgent!({ runId: '', config: { name: 'wf' } }),
    ).resolves.not.toThrow();

    // A fresh recovery run was created and the stale one was marked failed.
    const runs = await store.listRuns();
    expect(runs.length).toBe(2);
    expect(runs.some((r) => r.status === 'failed')).toBe(true);
    expect(runs.some((r) => r.status === 'running')).toBe(true);
  });

  it('keeps legacy behavior when neither side declares a version', async () => {
    await seedStaleRun({ name: 'wf' });

    const mw = createDurableMiddleware({
      store,
      config: { name: 'wf', staleTimeoutMs: 30_000 },
      eventBus,
    });

    await expect(
      mw.beforeAgent!({ runId: '', config: { name: 'wf' } }),
    ).resolves.not.toThrow();

    const runs = await store.listRuns();
    expect(runs.length).toBe(2);
  });
});

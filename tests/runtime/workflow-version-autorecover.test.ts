import { describe, it, expect, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';

function backdateHeartbeat(store: SqliteJournalStore, runId: string): void {
  const stale = new Date(Date.now() - 60_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).db
    .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
    .run(stale, runId);
}

describe('DurableWorkflow persists and enforces workflowVersion on auto-recovery', () => {
  let store: SqliteJournalStore;

  afterEach(() => {
    store.close();
  });

  it('persists workflowVersion into the run config on run()', async () => {
    store = new SqliteJournalStore(':memory:');
    const wf = new DurableWorkflow(
      'persist-version',
      async (ctx) => ctx.step('only', () => 'x'),
      { store, workflowVersion: 'v7' },
    );

    await wf.run(null);

    const runs = await store.listRuns();
    expect(runs[0].config.workflowVersion).toBe('v7');
  });

  it('skips auto-recovery of a stale run whose version is incompatible', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();

    // A stale run journaled under version v1.
    const stale = await store.createRun({ name: 'auto-rec', workflowVersion: 'v1' });
    await store.updateRun(stale.runId, { status: 'running' }, 0);
    await store.createStep(
      {
        stepId: 'st-0',
        runId: stale.runId,
        nodeName: 'step-0',
        sequence: 0,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      },
      0,
    );
    await store.recordOutcome(
      {
        outcomeId: 'oc-0',
        stepId: 'st-0',
        operationType: 'custom',
        operationKey: computeOperationKey(stale.runId, 'step-0', 0),
        result: 'cached-0',
        tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        durationMs: 1,
        recordedAt: new Date(),
      },
      0,
    );
    backdateHeartbeat(store, stale.runId);

    let fresh = 0;
    // A workflow at version v2 with autoRecover: it must NOT recover the v1 run.
    new DurableWorkflow(
      'auto-rec',
      async (ctx) => {
        await ctx.step('step-0', () => {
          fresh++;
          return 'new-0';
        });
        return 'done';
      },
      {
        store,
        eventBus,
        workflowVersion: 'v2',
        autoRecover: true,
        staleTimeoutMs: 10,
        heartbeatIntervalMs: 2,
      },
    );

    await new Promise((r) => setTimeout(r, 200));

    // The incompatible run was claimed (generation advanced) but not completed,
    // and no fresh step executed on its behalf.
    const after = await store.getRun(stale.runId);
    expect(after!.status).not.toBe('completed');
    expect(fresh).toBe(0);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';

/**
 * Access the private db field on SqliteJournalStore for test manipulation.
 * TypeScript private fields are just regular properties at runtime.
 */
function getRawDb(store: SqliteJournalStore) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (store as any).db as import('better-sqlite3').Database;
}

describe('Run lifecycle transitions', () => {
  let store: SqliteJournalStore;

  afterEach(() => {
    store.close();
  });

  it('run status becomes "running" before first step executes', async () => {
    store = new SqliteJournalStore(':memory:');
    let statusDuringStep: string | undefined;

    const workflow = new DurableWorkflow(
      'lifecycle-test',
      async (ctx) => {
        const result = await ctx.step('check-status', async () => {
          const run = await store.getRun(ctx.run.runId);
          statusDuringStep = run?.status;
          return 'done';
        });
        return result;
      },
      { store, heartbeatIntervalMs: 5_000, staleTimeoutMs: 30_000 },
    );

    await workflow.run('test-input');

    expect(statusDuringStep).toBe('running');
  });

  it('run in "running" with expired heartbeat is found by findStaleRuns', async () => {
    store = new SqliteJournalStore(':memory:');

    const run = await store.createRun({
      name: 'stale-test',
      heartbeatIntervalMs: 5_000,
      staleTimeoutMs: 30_000,
    });

    await store.updateRun(run.runId, { status: 'running' });

    // Backdate heartbeat to 60s ago via raw DB access
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    getRawDb(store)
      .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
      .run(pastDate, run.runId);

    const stale = await store.findStaleRuns(30_000);

    expect(stale).toHaveLength(1);
    expect(stale[0].runId).toBe(run.runId);
    expect(stale[0].status).toBe('running');
  });

  it('run in "pending" is NOT found by findStaleRuns', async () => {
    store = new SqliteJournalStore(':memory:');

    const run = await store.createRun({
      name: 'pending-test',
      heartbeatIntervalMs: 5_000,
      staleTimeoutMs: 30_000,
    });

    // Backdate heartbeat so it would be "expired" if status were checked
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    getRawDb(store)
      .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
      .run(pastDate, run.runId);

    // findStaleRuns only considers runs with status='running'
    const stale = await store.findStaleRuns(30_000);

    expect(stale).toHaveLength(0);
  });
});

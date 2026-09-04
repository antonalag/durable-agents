import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import type { RunConfig } from '../../src/core/types.js';

vi.mock('../../src/adapters/peer-check.js', () => ({
  assertPeerDependency: vi.fn(),
}));

const { createDurableMiddleware } = await import('../../src/adapters/langgraph.js');

describe('LangGraph adapter recovers every matching stale run', () => {
  let store: SqliteJournalStore;
  let eventBus: EventBus;
  const config: RunConfig = {
    name: 'multi-stale-wf',
    heartbeatIntervalMs: 60_000,
    staleTimeoutMs: 30_000,
  };

  beforeEach(() => {
    store = new SqliteJournalStore(':memory:');
    eventBus = new EventBus();
  });

  afterEach(() => {
    store.close();
  });

  async function makeStale(name: string): Promise<string> {
    const run = await store.createRun({ ...config, name });
    await store.updateRun(run.runId, { status: 'running' });
    const oldTime = new Date(Date.now() - 60_000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).db
      .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
      .run(oldTime, run.runId);
    return run.runId;
  }

  it('marks all matching stale runs failed, leaves others untouched, and starts one new run', async () => {
    const matchingIds = [
      await makeStale('multi-stale-wf'),
      await makeStale('multi-stale-wf'),
      await makeStale('multi-stale-wf'),
    ];
    const otherId = await makeStale('other-wf');

    const mw = createDurableMiddleware({ store, config, eventBus });
    await mw.beforeAgent!({ runId: '', config });

    for (const id of matchingIds) {
      const run = await store.getRun(id);
      expect(run!.status).toBe('failed');
    }

    const other = await store.getRun(otherId);
    expect(other!.status).toBe('running');

    const allRuns = await store.listRuns();
    const newRuns = allRuns.filter(
      (r) =>
        r.config.name === 'multi-stale-wf' &&
        r.status === 'running' &&
        !matchingIds.includes(r.runId),
    );
    expect(newRuns.length).toBe(1);
  });

  it('does not use the claim-fenced recovering status on the adapter path', async () => {
    await makeStale('multi-stale-wf');
    await makeStale('multi-stale-wf');

    const claimSpy = vi.spyOn(store, 'claimRunForRecovery');

    const mw = createDurableMiddleware({ store, config, eventBus });
    await mw.beforeAgent!({ runId: '', config });

    expect(claimSpy).not.toHaveBeenCalled();

    const allRuns = await store.listRuns();
    expect(allRuns.some((r) => r.status === 'recovering')).toBe(false);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { statusBadge } from '../../src/dashboard/views/status-badge.js';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import type { WorkflowFn } from '../../src/runtime/workflow.js';

function backdateHeartbeat(store: SqliteJournalStore, runId: string): void {
  const stale = new Date(Date.now() - 60_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).db
    .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
    .run(stale, runId);
}

describe('claimRunForRecovery behavior', () => {
  it('claims a running run and returns it flipped to recovering', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const run = await store.createRun({ name: 'claim-running' });
      await store.updateRun(run.runId, { status: 'running' });

      const claimed = await store.claimRunForRecovery(run.runId);
      expect(claimed).not.toBeNull();
      expect(claimed!.status).toBe('recovering');
    } finally {
      store.close();
    }
  });

  it('returns null for a completed run', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const run = await store.createRun({ name: 'claim-completed' });
      await store.updateRun(run.runId, { status: 'completed' });

      expect(await store.claimRunForRecovery(run.runId)).toBeNull();
    } finally {
      store.close();
    }
  });

  it('re-claims a recovering run whose heartbeat has expired', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const run = await store.createRun({ name: 'claim-recovering' });
      await store.updateRun(run.runId, { status: 'running' });
      await store.claimRunForRecovery(run.runId);
      backdateHeartbeat(store, run.runId);

      const reclaimed = await store.claimRunForRecovery(run.runId);
      expect(reclaimed).not.toBeNull();
      expect(reclaimed!.status).toBe('recovering');
    } finally {
      store.close();
    }
  });
});

describe('findStaleRuns eligibility', () => {
  it('includes both running and recovering runs with an expired heartbeat', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const runningRun = await store.createRun({ name: 'stale-running' });
      await store.updateRun(runningRun.runId, { status: 'running' });
      backdateHeartbeat(store, runningRun.runId);

      const recoveringRun = await store.createRun({ name: 'stale-recovering' });
      await store.updateRun(recoveringRun.runId, { status: 'running' });
      await store.claimRunForRecovery(recoveringRun.runId);
      backdateHeartbeat(store, recoveringRun.runId);

      const stale = await store.findStaleRuns(30_000);
      const ids = stale.map((r) => r.runId);
      expect(ids).toContain(runningRun.runId);
      expect(ids).toContain(recoveringRun.runId);
    } finally {
      store.close();
    }
  });

  it('excludes a recovering run whose heartbeat is fresh', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const run = await store.createRun({ name: 'fresh-recovering' });
      await store.updateRun(run.runId, { status: 'running' });
      await store.claimRunForRecovery(run.runId);
      await store.updateHeartbeat(run.runId);

      const stale = await store.findStaleRuns(30_000);
      expect(stale.some((r) => r.runId === run.runId)).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe('stale-run recovery gate', () => {
  it('does not recover a run when the claim is not granted', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const eventBus = new EventBus();

      const staleRun = await store.createRun({
        name: 'skip-recovery',
        heartbeatIntervalMs: 10_000,
        staleTimeoutMs: 30_000,
        metadata: { input: null },
      });
      await store.updateRun(staleRun.runId, { status: 'running' });
      backdateHeartbeat(store, staleRun.runId);

      // Another worker already holds the claim → this worker's claim fails.
      const claimSpy = vi
        .spyOn(store, 'claimRunForRecovery')
        .mockResolvedValue(null);

      let fnRan = false;
      const workflowFn: WorkflowFn<null, string> = async (ctx) => {
        fnRan = true;
        await ctx.step('s', () => 'x');
        return 'done';
      };

      new DurableWorkflow<null, string>('skip-recovery', workflowFn, {
        store,
        eventBus,
        autoRecover: true,
        staleTimeoutMs: 10,
        heartbeatIntervalMs: 2,
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(claimSpy).toHaveBeenCalledWith(staleRun.runId);
      expect(fnRan).toBe(false);
      const stillRunning = await store.getRun(staleRun.runId);
      expect(stillRunning!.status).toBe('running');
    } finally {
      store.close();
    }
  });
});

describe('statusBadge renders recovering distinctly', () => {
  it('uses the badge-recovering class rather than the unknown fallback', () => {
    const html = statusBadge('recovering');
    expect(html).toContain('badge-recovering');
    expect(html).not.toContain('badge-unknown');
    expect(html).toContain('>recovering<');
  });
});

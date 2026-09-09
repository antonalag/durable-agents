import { describe, it, expect } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { RecoveryEngine } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { DurableError } from '../../src/errors.js';
import type { DurableContextImpl, WorkflowFn } from '../../src/runtime/workflow.js';

function backdateHeartbeat(store: SqliteJournalStore, runId: string): void {
  const stale = new Date(Date.now() - 60_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).db
    .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
    .run(stale, runId);
}

function isFenced(error: unknown): boolean {
  return error instanceof DurableError && error.code === 'FENCED';
}

describe('two recovery engines racing the same stale run', () => {
  it('lets only the highest-generation engine persist; the superseded one is fenced, aborts, and writes no terminal state', async () => {
    const store = new SqliteJournalStore(':memory:');
    const failedEvents: string[] = [];

    try {
      const eventBus = new EventBus();
      eventBus.on('run:failed', (e) => failedEvents.push(e.runId));

      const run = await store.createRun({
        name: 'race-wf',
        heartbeatIntervalMs: 10_000,
        staleTimeoutMs: 30_000,
        metadata: { input: null },
      });
      await store.updateRun(run.runId, { status: 'running' }, 0);
      backdateHeartbeat(store, run.runId);

      // Both workers claim the stale run before either heals it. The second
      // claim advances the generation, so the first claimant is now superseded.
      const claimA = await store.claimRunForRecovery(run.runId);
      backdateHeartbeat(store, run.runId);
      const claimB = await store.claimRunForRecovery(run.runId);

      expect(claimA).not.toBeNull();
      expect(claimB).not.toBeNull();
      expect(claimB!.generation).toBeGreaterThan(claimA!.generation);

      const workflowFn: WorkflowFn<null, string> = async (
        ctx: DurableContextImpl,
      ) => {
        await ctx.step('only-step', () => 'value');
        return 'done';
      };

      const engineA = new RecoveryEngine(store, eventBus, 30_000);
      const engineB = new RecoveryEngine(store, eventBus, 30_000);

      const settled = await Promise.allSettled([
        engineA.recover(run.runId, workflowFn, null, claimA!.generation),
        engineB.recover(run.runId, workflowFn, null, claimB!.generation),
      ]);

      const [resultA, resultB] = settled;

      // The winner (B, current generation) completes; the loser (A) is fenced.
      expect(resultB.status).toBe('fulfilled');
      expect(resultA.status).toBe('rejected');
      if (resultA.status === 'rejected') {
        expect(isFenced(resultA.reason)).toBe(true);
      }

      // The fenced engine wrote no terminal state and emitted no run:failed.
      expect(failedEvents).not.toContain(run.runId);

      // Final run state reflects only the winner: completed at B's generation.
      const persisted = await store.getRun(run.runId);
      expect(persisted!.status).toBe('completed');
      expect(persisted!.recoveryGeneration).toBe(claimB!.generation);

      // Exactly one journal for the single step (the winner's); the fenced
      // engine's createStep was rejected, so no orphan step rows accumulate.
      const steps = await store.listSteps(run.runId);
      expect(steps).toHaveLength(1);
      expect(steps[0].status).toBe('completed');
    } finally {
      store.close();
    }
  });
});

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';

describe('recovery claim on a running run', () => {
  it('transitions the run to recovering exactly once, from a running heartbeat, in a real scan', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (workers) => {
        const store = new SqliteJournalStore(':memory:');
        try {
          const run = await store.createRun({ name: 'claim-scan' });
          await store.updateRun(run.runId, { status: 'running' });
          // Backdate heartbeat so the run is stale and offered for recovery.
          const stale = new Date(Date.now() - 60_000).toISOString();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (store as any).db
            .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
            .run(stale, run.runId);

          // Each worker independently scans for stale runs, then claims what it
          // found. A worker that flipped the run to recovering keeps its
          // heartbeat fresh, so later scanners no longer see it as stale.
          let winners = 0;
          for (let i = 0; i < workers; i++) {
            const staleRuns = await store.findStaleRuns(30_000);
            if (staleRuns.some((r) => r.runId === run.runId)) {
              const claimed = await store.claimRunForRecovery(run.runId);
              if (claimed) {
                winners++;
                await store.updateHeartbeat(run.runId);
              }
            }
          }

          expect(winners).toBe(1);
          const persisted = await store.getRun(run.runId);
          expect(persisted!.status).toBe('recovering');
        } finally {
          store.close();
        }
      }),
      { numRuns: 50 },
    );
  });

  it('returns null for a terminal run', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('completed', 'failed', 'terminated') as fc.Arbitrary<
          'completed' | 'failed' | 'terminated'
        >,
        async (terminalStatus) => {
          const store = new SqliteJournalStore(':memory:');
          try {
            const run = await store.createRun({ name: 'claim-terminal' });
            await store.updateRun(run.runId, { status: terminalStatus });

            const result = await store.claimRunForRecovery(run.runId);
            expect(result).toBeNull();

            const persisted = await store.getRun(run.runId);
            expect(persisted!.status).toBe(terminalStatus);
          } finally {
            store.close();
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('recovery claim survives a worker crash', () => {
  function backdateHeartbeat(store: SqliteJournalStore, runId: string): void {
    const stale = new Date(Date.now() - 60_000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).db
      .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
      .run(stale, runId);
  }

  it('lets a second worker re-claim after the first crashes mid-recovery', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const run = await store.createRun({ name: 'crash-recovery' });
      await store.updateRun(run.runId, { status: 'running' });
      backdateHeartbeat(store, run.runId);

      // Worker A claims the stale run: running -> recovering.
      const claimedByA = await store.claimRunForRecovery(run.runId);
      expect(claimedByA).not.toBeNull();
      expect(claimedByA!.status).toBe('recovering');

      // Worker B, while A is alive with a fresh heartbeat, sees nothing to claim.
      await store.updateHeartbeat(run.runId);
      const freshStale = await store.findStaleRuns(30_000);
      expect(freshStale.some((r) => r.runId === run.runId)).toBe(false);

      // Worker A crashes mid-recovery: its heartbeat stops and goes stale.
      backdateHeartbeat(store, run.runId);

      // A stale scan re-detects the recovering run (non-terminal, re-eligible).
      const reDetected = await store.findStaleRuns(30_000);
      expect(reDetected.some((r) => r.runId === run.runId)).toBe(true);

      // Worker B re-claims it.
      const claimedByB = await store.claimRunForRecovery(run.runId);
      expect(claimedByB).not.toBeNull();
      expect(claimedByB!.status).toBe('recovering');

      const persisted = await store.getRun(run.runId);
      expect(persisted!.status).toBe('recovering');
    } finally {
      store.close();
    }
  });
});

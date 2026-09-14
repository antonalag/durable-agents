import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableError } from '../../src/errors.js';
import type { OutcomeRecord, Step, TokenCost } from '../../src/core/types.js';

const ZERO_COST: TokenCost = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

function backdateHeartbeat(store: SqliteJournalStore, runId: string): void {
  const stale = new Date(Date.now() - 60_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).db
    .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
    .run(stale, runId);
}

function makeStep(runId: string, sequence: number): Omit<Step, 'completedAt'> {
  return {
    stepId: randomUUID(),
    runId,
    nodeName: `step-${sequence}`,
    sequence,
    status: 'running',
    startedAt: new Date(),
    cost: ZERO_COST,
    attempt: 1,
  };
}

function makeOutcome(stepId: string): OutcomeRecord {
  return {
    outcomeId: randomUUID(),
    stepId,
    operationType: 'custom',
    operationKey: randomUUID(),
    result: { ok: true },
    tokens: ZERO_COST,
    durationMs: 1,
    recordedAt: new Date(),
  };
}

function isFenced(error: unknown): boolean {
  return error instanceof DurableError && error.code === 'FENCED';
}

describe('concurrent recovery claims', () => {
  it('grant each racing claimant a distinct, strictly increasing generation', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (claimants) => {
        const store = new SqliteJournalStore(':memory:');
        try {
          const run = await store.createRun({ name: 'racing-claims' });
          await store.updateRun(run.runId, { status: 'running' }, 0);
          backdateHeartbeat(store, run.runId);

          // A stale 'recovering' run stays eligible, so more than one claimant
          // may win a claim. Each winner must receive a distinct generation.
          const generations: number[] = [];
          for (let i = 0; i < claimants; i++) {
            const claim = await store.claimRunForRecovery(run.runId);
            if (claim) generations.push(claim.generation);
          }

          expect(generations.length).toBeGreaterThan(0);
          const unique = new Set(generations);
          expect(unique.size).toBe(generations.length);

          const sorted = [...generations].sort((a, b) => a - b);
          for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i]).toBeGreaterThan(sorted[i - 1]);
          }

          // Persisted generation equals the maximum granted.
          const persisted = await store.getRun(run.runId);
          expect(persisted!.recoveryGeneration).toBe(Math.max(...generations));
          expect(persisted!.status).toBe('recovering');
        } finally {
          store.close();
        }
      }),
      { numRuns: 50 },
    );
  });

  it('let only the highest-generation holder persist writes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (claimants) => {
        const store = new SqliteJournalStore(':memory:');
        try {
          const run = await store.createRun({ name: 'only-max-writes' });
          await store.updateRun(run.runId, { status: 'running' }, 0);
          backdateHeartbeat(store, run.runId);

          const generations: number[] = [];
          for (let i = 0; i < claimants; i++) {
            const claim = await store.claimRunForRecovery(run.runId);
            if (claim) generations.push(claim.generation);
          }
          const maxGen = Math.max(...generations);

          for (const gen of generations) {
            const step = makeStep(run.runId, gen);
            if (gen === maxGen) {
              await expect(store.createStep(step, gen)).resolves.toBeDefined();
              await expect(
                store.recordOutcome(makeOutcome(step.stepId), gen),
              ).resolves.toBeDefined();
              await expect(
                store.updateRun(run.runId, { status: 'completed' }, gen),
              ).resolves.toBeDefined();
            } else {
              await expect(store.createStep(step, gen)).rejects.toSatisfy(
                isFenced,
              );
            }
          }
        } finally {
          store.close();
        }
      }),
      { numRuns: 30 },
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
            await store.updateRun(run.runId, { status: terminalStatus }, 0);

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

describe('a reclaim fences the crashed owner across every write type', () => {
  it('rejects every ownership-sensitive write carrying the superseded generation', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const run = await store.createRun({ name: 'crash-fences-all' });
      await store.updateRun(run.runId, { status: 'running' }, 0);
      backdateHeartbeat(store, run.runId);

      // Worker A claims (generation 1) and seeds a step to update/heal later.
      const claimA = await store.claimRunForRecovery(run.runId);
      expect(claimA).not.toBeNull();
      const genA = claimA!.generation;

      const seededStep = makeStep(run.runId, 0);
      await store.createStep(seededStep, genA);

      // A crashes; its heartbeat expires and the run is re-claimable.
      backdateHeartbeat(store, run.runId);
      const claimB = await store.claimRunForRecovery(run.runId);
      expect(claimB).not.toBeNull();
      const genB = claimB!.generation;
      expect(genB).toBeGreaterThan(genA);

      // Every write A now attempts at genA is fenced.
      expect(await store.updateHeartbeat(run.runId, genA)).toBe(false);
      await expect(
        store.createStep(makeStep(run.runId, 1), genA),
      ).rejects.toSatisfy(isFenced);
      await expect(
        store.recordOutcome(makeOutcome(seededStep.stepId), genA),
      ).rejects.toSatisfy(isFenced);
      await expect(
        store.updateStep(seededStep.stepId, { status: 'completed' }, genA),
      ).rejects.toSatisfy(isFenced);
      await expect(
        store.updateRun(run.runId, { status: 'failed' }, genA),
      ).rejects.toSatisfy(isFenced);
      await expect(
        store.updateRun(run.runId, { status: 'completed' }, genA),
      ).rejects.toSatisfy(isFenced);
      await expect(
        store.updateRun(run.runId, { status: 'terminated' }, genA),
      ).rejects.toSatisfy(isFenced);

      // B at genB writes normally.
      expect(await store.updateHeartbeat(run.runId, genB)).toBe(true);
      await expect(
        store.updateStep(seededStep.stepId, { status: 'completed' }, genB),
      ).resolves.toBeDefined();
      await expect(
        store.updateRun(run.runId, { status: 'completed' }, genB),
      ).resolves.toBeDefined();

      const persisted = await store.getRun(run.runId);
      expect(persisted!.status).toBe('completed');
      expect(persisted!.recoveryGeneration).toBe(genB);
    } finally {
      store.close();
    }
  });
});

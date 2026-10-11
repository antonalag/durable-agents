import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { Pool } from 'pg';
import { PostgresJournalStore } from '../../src/stores/postgres.js';
import { DurableError } from '../../src/errors.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { OutcomeRecord } from '../../src/core/types.js';

let container: StartedTestContainer;
let connectionConfig: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'test_journal',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections'))
    .start();

  connectionConfig = {
    host: container.getHost(),
    port: container.getMappedPort(5432),
    user: 'test',
    password: 'test',
    database: 'test_journal',
  };

  const pool = new Pool(connectionConfig);
  let retries = 10;
  while (retries > 0) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch {
      retries--;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await pool.end();
  if (retries === 0) throw new Error('Postgres container did not become ready');
}, 60000);

afterAll(async () => {
  if (container) await container.stop();
});

function isFenced(error: unknown): boolean {
  return error instanceof DurableError && error.code === 'FENCED';
}

function makeOutcome(stepId: string, operationKey: string): OutcomeRecord {
  return {
    outcomeId: randomUUID(),
    stepId,
    operationType: 'custom',
    operationKey,
    result: { ok: true },
    tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    durationMs: 1,
    recordedAt: new Date(),
  };
}

describe('Postgres fencing under interleaved concurrent writers', () => {
  it('never lets a superseded generation persist a child row even when its claim and write race the winner', async () => {
    // Two independent pools model two separate workers/connections. Each
    // iteration: both claim the same stale run (B supersedes A), then both race
    // to create a step and record an outcome with the generation they hold. The
    // invariant under any interleaving: exactly one step row and one outcome
    // survive per run, and the surviving writes belong to the highest generation.
    const storeA = new PostgresJournalStore(connectionConfig);
    const storeB = new PostgresJournalStore(connectionConfig);
    await storeA.migrate();

    const ITERATIONS = 40;

    try {
      for (let iter = 0; iter < ITERATIONS; iter++) {
        const run = await storeA.createRun({ name: `concurrent-fence-${iter}` });
        await storeA.updateRun(run.runId, { status: 'running' }, 0);

        // Both workers claim; the second claim strictly supersedes the first.
        const [claimA, claimB] = await Promise.all([
          storeA.claimRunForRecovery(run.runId),
          storeB.claimRunForRecovery(run.runId),
        ]);
        expect(claimA).not.toBeNull();
        expect(claimB).not.toBeNull();

        const genLow = Math.min(claimA!.generation, claimB!.generation);
        const genHigh = Math.max(claimA!.generation, claimB!.generation);
        expect(genHigh).toBeGreaterThan(genLow);

        const stepLow = randomUUID();
        const stepHigh = randomUUID();
        const opKeyLow = computeOperationKey(run.runId, 'branch', 0, genLow);
        const opKeyHigh = computeOperationKey(run.runId, 'branch', 0, genHigh);

        // Race the loser (low generation) and the winner (high generation)
        // through the full createStep -> recordOutcome path simultaneously.
        const loser = (async () => {
          await storeA.createStep(
            {
              stepId: stepLow,
              runId: run.runId,
              nodeName: 'branch',
              sequence: 0,
              status: 'running',
              startedAt: new Date(),
              cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
              attempt: 1,
            },
            genLow,
          );
          await storeA.recordOutcome(makeOutcome(stepLow, opKeyLow), genLow);
        })();

        const winner = (async () => {
          await storeB.createStep(
            {
              stepId: stepHigh,
              runId: run.runId,
              nodeName: 'branch',
              sequence: 0,
              status: 'running',
              startedAt: new Date(),
              cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
              attempt: 1,
            },
            genHigh,
          );
          await storeB.recordOutcome(makeOutcome(stepHigh, opKeyHigh), genHigh);
        })();

        const [loserResult, winnerResult] = await Promise.allSettled([loser, winner]);

        // The winner (current generation) must always succeed.
        expect(winnerResult.status).toBe('fulfilled');

        // The loser (superseded generation) must be fenced, never partially
        // applied. If it rejected, it must be a FENCED error.
        if (loserResult.status === 'rejected') {
          expect(isFenced(loserResult.reason)).toBe(true);
        }

        // Ground truth from the database: the loser's generation left no rows.
        const steps = await storeA.listSteps(run.runId);
        const loserStep = steps.find((s) => s.stepId === stepLow);
        expect(loserStep).toBeUndefined();

        const loserOutcome = await storeA.getOutcomeByKey(opKeyLow);
        expect(loserOutcome).toBeNull();

        // The winner's rows are present exactly once.
        const winnerStep = steps.find((s) => s.stepId === stepHigh);
        expect(winnerStep).toBeDefined();
        const winnerOutcome = await storeA.getOutcomeByKey(opKeyHigh);
        expect(winnerOutcome).not.toBeNull();

        // The persisted generation reflects the winner.
        const persistedRun = await storeA.getRun(run.runId);
        expect(persistedRun!.recoveryGeneration).toBe(genHigh);
      }
    } finally {
      await storeA.close();
      await storeB.close();
    }
  }, 60000);
});

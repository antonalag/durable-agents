import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { Pool } from 'pg';
import { PostgresJournalStore } from '../../src/stores/postgres.js';
import { DurableError } from '../../src/errors.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import { journalStoreSuite } from './journal-store.suite.js';

let container: StartedTestContainer;
let connectionConfig: { host: string; port: number; user: string; password: string; database: string };

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

  // Extra safety: verify connection works before proceeding
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
  if (container) {
    await container.stop();
  }
});

journalStoreSuite('PostgreSQL', async () => {
  const store = new PostgresJournalStore(connectionConfig);

  const pool = new Pool(connectionConfig);
  await pool.query('DROP TABLE IF EXISTS outcomes CASCADE');
  await pool.query('DROP TABLE IF EXISTS steps CASCADE');
  await pool.query('DROP TABLE IF EXISTS runs CASCADE');
  await pool.end();

  await store.migrate();

  return {
    store,
    teardown: async () => {
      await store.close();
    },
  };
});

describe('PostgresJournalStore specifics', () => {
  it('migrate() creates tables idempotently', async () => {
    const store = new PostgresJournalStore(connectionConfig);
    await store.migrate();
    await store.migrate();
    const run = await store.createRun({ name: 'idempotent-test' });
    expect(run.runId).toBeTruthy();
    await store.close();
  });

  it('supports the documented construct then migrate then use setup', async () => {
    const store = new PostgresJournalStore(connectionConfig);
    try {
      await store.migrate();

      const created = await store.createRun({ name: 'documented-setup' });
      const read = await store.getRun(created.runId);

      expect(read).not.toBeNull();
      expect(read!.runId).toBe(created.runId);
      expect(read!.config.name).toBe('documented-setup');
      expect(read!.recoveryGeneration).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('rejects a write from a superseded generation and admits the current one', async () => {
    const store = new PostgresJournalStore(connectionConfig);
    try {
      await store.migrate();

      const run = await store.createRun({ name: 'fencing-smoke' });
      await store.updateRun(run.runId, { status: 'running' }, 0);

      const claimA = await store.claimRunForRecovery(run.runId);
      const claimB = await store.claimRunForRecovery(run.runId);

      expect(claimA).not.toBeNull();
      expect(claimB).not.toBeNull();
      expect(claimA!.generation).toBe(1);
      expect(claimB!.generation).toBe(2);

      // The superseded owner (generation 1) is fenced: its write throws and
      // persists nothing.
      await expect(
        store.updateRun(run.runId, { status: 'completed' }, claimA!.generation),
      ).rejects.toMatchObject({ code: 'FENCED' });

      const afterFenced = await store.getRun(run.runId);
      expect(afterFenced!.status).toBe('recovering');

      // The current owner (generation 2) writes successfully.
      await store.updateRun(run.runId, { status: 'completed' }, claimB!.generation);

      const afterWinner = await store.getRun(run.runId);
      expect(afterWinner!.status).toBe('completed');
      expect(afterWinner!.recoveryGeneration).toBe(2);
    } finally {
      await store.close();
    }
  });

  it('fences a recordOutcome carrying a superseded generation', async () => {
    const store = new PostgresJournalStore(connectionConfig);
    try {
      await store.migrate();

      const run = await store.createRun({ name: 'fencing-outcome' });
      await store.updateRun(run.runId, { status: 'running' }, 0);

      const stepId = randomUUID();
      await store.createStep({
        stepId,
        runId: run.runId,
        nodeName: 'step-0',
        sequence: 0,
        status: 'running',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      }, 0);

      const claimA = await store.claimRunForRecovery(run.runId);
      const claimB = await store.claimRunForRecovery(run.runId);
      expect(claimB!.generation).toBeGreaterThan(claimA!.generation);

      const outcome = {
        outcomeId: randomUUID(),
        stepId,
        operationType: 'custom' as const,
        operationKey: computeOperationKey(run.runId, 'step-0', 0),
        result: 'value',
        tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        durationMs: 1,
        recordedAt: new Date(),
      };

      await expect(
        store.recordOutcome(outcome, claimA!.generation),
      ).rejects.toBeInstanceOf(DurableError);

      // Nothing was persisted for the fenced write.
      expect(await store.getOutcomeByKey(outcome.operationKey)).toBeNull();

      // The current generation persists the outcome.
      await store.recordOutcome(outcome, claimB!.generation);
      const persisted = await store.getOutcomeByKey(outcome.operationKey);
      expect(persisted).not.toBeNull();
    } finally {
      await store.close();
    }
  });
});

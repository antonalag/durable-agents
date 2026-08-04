import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { Pool } from 'pg';
import { PostgresJournalStore } from '../../src/stores/postgres.js';
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
});

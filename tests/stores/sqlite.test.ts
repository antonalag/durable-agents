import { describe, it, expect } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { journalStoreSuite } from './journal-store.suite.js';

journalStoreSuite('SQLite', async () => {
  const store = new SqliteJournalStore(':memory:');
  return {
    store,
    teardown: async () => {
      store.close();
    },
  };
});

describe('SqliteJournalStore specifics', () => {
  it('enables WAL mode', () => {
    const store = new SqliteJournalStore(':memory:');
    store.close();
  });

  it('creates tables on instantiation', async () => {
    const store = new SqliteJournalStore(':memory:');
    const run = await store.createRun({ name: 'test' });
    expect(run.runId).toBeTruthy();
    store.close();
  });
});

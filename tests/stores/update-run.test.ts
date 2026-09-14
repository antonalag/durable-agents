import { describe, it, expect } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';

describe('updateRun single-statement behavior', () => {
  it('a single-field update changes only that field', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const run = await store.createRun({ name: 'single-field' });
      const before = await store.getRun(run.runId);

      await store.updateRun(run.runId, { status: 'running' }, 0);

      const after = await store.getRun(run.runId);
      expect(after!.status).toBe('running');
      expect(after!.metadata).toEqual(before!.metadata);
      expect(after!.totals).toEqual(before!.totals);
    } finally {
      store.close();
    }
  });

  it('applies status and totals together in one update', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const run = await store.createRun({ name: 'combined' });

      await store.updateRun(run.runId, {
        status: 'completed',
        totals: { cost: 1.25, tokens: 4200, steps: 7, recoveryCount: 1 },
      }, 0);

      const after = await store.getRun(run.runId);
      expect(after!.status).toBe('completed');
      expect(after!.totals).toEqual({
        cost: 1.25,
        tokens: 4200,
        steps: 7,
        recoveryCount: 1,
      });
    } finally {
      store.close();
    }
  });

  it('leaves other fields unchanged when only metadata is updated', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const run = await store.createRun({ name: 'metadata-only' });
      await store.updateRun(run.runId, {
        status: 'running',
        totals: { cost: 0.5, tokens: 100, steps: 2, recoveryCount: 0 },
      }, 0);

      await store.updateRun(run.runId, { metadata: { note: 'updated' } }, 0);

      const after = await store.getRun(run.runId);
      expect(after!.metadata).toEqual({ note: 'updated' });
      expect(after!.status).toBe('running');
      expect(after!.totals.cost).toBe(0.5);
      expect(after!.totals.steps).toBe(2);
    } finally {
      store.close();
    }
  });

  it('bumps updatedAt on every update', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const run = await store.createRun({ name: 'updated-at' });
      const before = await store.getRun(run.runId);

      await new Promise((r) => setTimeout(r, 5));
      await store.updateRun(run.runId, { status: 'running' }, 0);

      const after = await store.getRun(run.runId);
      expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(
        before!.updatedAt.getTime(),
      );
    } finally {
      store.close();
    }
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cost-usd-migration-'));
  tempDirs.push(dir);
  return join(dir, 'journal.db');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('cost_usd schema and migration', () => {
  it('fresh store outcomes table includes a cost_usd column', () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const cols = (
        store as unknown as { db: Database.Database }
      ).db
        .prepare('PRAGMA table_info(outcomes)')
        .all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'cost_usd')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('re-opening a store that already has cost_usd does not throw', () => {
    const path = tempDbPath();
    const first = new SqliteJournalStore(path);
    first.close();
    expect(() => {
      const second = new SqliteJournalStore(path);
      second.close();
    }).not.toThrow();
  });

  it('migrates a legacy outcomes table and resolves legacy costUsd to 0', async () => {
    const path = tempDbPath();

    const raw = new Database(path);
    raw.pragma('foreign_keys = ON');
    raw.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
        config TEXT NOT NULL, metadata TEXT DEFAULT '{}',
        total_cost REAL DEFAULT 0, total_tokens INTEGER DEFAULT 0,
        total_steps INTEGER DEFAULT 0, recovery_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_heartbeat TEXT NOT NULL
      );
      CREATE TABLE steps (
        step_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        node_name TEXT NOT NULL, sequence INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', started_at TEXT NOT NULL,
        completed_at TEXT, input_state_hash TEXT,
        cost_input_tokens INTEGER DEFAULT 0, cost_output_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0, attempt INTEGER DEFAULT 1
      );
      CREATE TABLE outcomes (
        outcome_id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
        operation_type TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE,
        result BLOB NOT NULL, token_input INTEGER DEFAULT 0,
        token_output INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0,
        recorded_at TEXT NOT NULL
      );
    `);

    const now = new Date().toISOString();
    const runId = randomUUID();
    const stepId = randomUUID();
    const outcomeId = randomUUID();
    const operationKey = 'legacy-op-key';
    raw.prepare(
      `INSERT INTO runs (run_id, status, config, metadata, created_at, updated_at, last_heartbeat)
       VALUES (?, 'running', '{"name":"legacy"}', '{}', ?, ?, ?)`,
    ).run(runId, now, now, now);
    raw.prepare(
      `INSERT INTO steps (step_id, run_id, node_name, sequence, status, started_at)
       VALUES (?, ?, 'legacy-step', 0, 'completed', ?)`,
    ).run(stepId, runId, now);
    raw.prepare(
      `INSERT INTO outcomes (outcome_id, step_id, operation_type, operation_key, result, recorded_at)
       VALUES (?, ?, 'custom', ?, ?, ?)`,
    ).run(outcomeId, stepId, operationKey, Buffer.from('"legacy-result"'), now);
    raw.close();

    const store = new SqliteJournalStore(path);
    try {
      const cols = (
        store as unknown as { db: Database.Database }
      ).db
        .prepare('PRAGMA table_info(outcomes)')
        .all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'cost_usd')).toBe(true);

      const outcome = await store.getOutcomeByKey(operationKey);
      expect(outcome).not.toBeNull();
      expect(outcome!.tokens.costUsd).toBe(0);
    } finally {
      store.close();
    }
  });
});

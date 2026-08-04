import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { JournalStore, ListRunsFilter } from './interface.js';
import type {
  ExecutionRun,
  OutcomeRecord,
  RunConfig,
  Step,
} from '../core/types.js';
import { serialize, deserialize } from '../serialization/serializer.js';

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  config TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  total_cost REAL DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  total_steps INTEGER DEFAULT 0,
  recovery_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_heartbeat TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steps (
  step_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  node_name TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  input_state_hash TEXT,
  cost_input_tokens INTEGER DEFAULT 0,
  cost_output_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  attempt INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS outcomes (
  outcome_id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  result BLOB NOT NULL,
  token_input INTEGER DEFAULT 0,
  token_output INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outcomes_opkey ON outcomes(operation_key);
CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, last_heartbeat);
`;

export class SqliteJournalStore implements JournalStore {
  private db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_DDL);
  }

  async createRun(config: RunConfig): Promise<ExecutionRun> {
    const now = new Date();
    const run: ExecutionRun = {
      runId: randomUUID(),
      status: 'pending',
      config,
      metadata: config.metadata ?? {},
      totals: { cost: 0, tokens: 0, steps: 0, recoveryCount: 0 },
      createdAt: now,
      updatedAt: now,
      lastHeartbeat: now,
    };

    this.db
      .prepare(
        `INSERT INTO runs (run_id, status, config, metadata, total_cost, total_tokens, total_steps, recovery_count, created_at, updated_at, last_heartbeat)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.runId,
        run.status,
        serialize(run.config),
        serialize(run.metadata),
        run.totals.cost,
        run.totals.tokens,
        run.totals.steps,
        run.totals.recoveryCount,
        run.createdAt.toISOString(),
        run.updatedAt.toISOString(),
        run.lastHeartbeat.toISOString(),
      );

    return Promise.resolve(run);
  }

  async getRun(runId: string): Promise<ExecutionRun | null> {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE run_id = ?')
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) return Promise.resolve(null);
    return Promise.resolve(this.rowToRun(row));
  }

  async updateRun(
    runId: string,
    updates: Partial<Pick<ExecutionRun, 'status' | 'metadata' | 'totals'>>,
  ): Promise<ExecutionRun> {
    const existing = await this.getRun(runId);
    if (!existing) throw new Error(`Run not found: ${runId}`);

    const now = new Date();
    if (updates.status !== undefined) {
      this.db
        .prepare('UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?')
        .run(updates.status, now.toISOString(), runId);
    }
    if (updates.metadata !== undefined) {
      this.db
        .prepare(
          'UPDATE runs SET metadata = ?, updated_at = ? WHERE run_id = ?',
        )
        .run(serialize(updates.metadata), now.toISOString(), runId);
    }
    if (updates.totals !== undefined) {
      this.db
        .prepare(
          'UPDATE runs SET total_cost = ?, total_tokens = ?, total_steps = ?, recovery_count = ?, updated_at = ? WHERE run_id = ?',
        )
        .run(
          updates.totals.cost,
          updates.totals.tokens,
          updates.totals.steps,
          updates.totals.recoveryCount,
          now.toISOString(),
          runId,
        );
    }

    return (await this.getRun(runId))!;
  }

  async listRuns(filter?: ListRunsFilter): Promise<ExecutionRun[]> {
    let sql = 'SELECT * FROM runs';
    const params: unknown[] = [];

    if (filter?.status) {
      sql += ' WHERE status = ?';
      params.push(filter.status);
    }
    sql += ' ORDER BY created_at DESC';
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    if (filter?.offset) {
      sql += ' OFFSET ?';
      params.push(filter.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<
      string,
      unknown
    >[];
    return Promise.resolve(rows.map((row) => this.rowToRun(row)));
  }

  async deleteRun(runId: string): Promise<void> {
    this.db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
    return Promise.resolve();
  }

  async createStep(step: Omit<Step, 'completedAt'>): Promise<Step> {
    this.db
      .prepare(
        `INSERT INTO steps (step_id, run_id, node_name, sequence, status, started_at, input_state_hash, cost_input_tokens, cost_output_tokens, cost_usd, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        step.stepId,
        step.runId,
        step.nodeName,
        step.sequence,
        step.status,
        step.startedAt.toISOString(),
        step.inputStateHash ?? null,
        step.cost.inputTokens,
        step.cost.outputTokens,
        step.cost.costUsd,
        step.attempt,
      );
    return Promise.resolve({ ...step, completedAt: undefined });
  }

  async getStep(stepId: string): Promise<Step | null> {
    const row = this.db
      .prepare('SELECT * FROM steps WHERE step_id = ?')
      .get(stepId) as Record<string, unknown> | undefined;
    if (!row) return Promise.resolve(null);
    return Promise.resolve(this.rowToStep(row));
  }

  async updateStep(
    stepId: string,
    updates: Partial<Pick<Step, 'status' | 'completedAt' | 'cost' | 'attempt'>>,
  ): Promise<Step> {
    if (updates.status !== undefined) {
      this.db
        .prepare('UPDATE steps SET status = ? WHERE step_id = ?')
        .run(updates.status, stepId);
    }
    if (updates.completedAt !== undefined) {
      this.db
        .prepare('UPDATE steps SET completed_at = ? WHERE step_id = ?')
        .run(updates.completedAt.toISOString(), stepId);
    }
    if (updates.cost !== undefined) {
      this.db
        .prepare(
          'UPDATE steps SET cost_input_tokens = ?, cost_output_tokens = ?, cost_usd = ? WHERE step_id = ?',
        )
        .run(
          updates.cost.inputTokens,
          updates.cost.outputTokens,
          updates.cost.costUsd,
          stepId,
        );
    }
    if (updates.attempt !== undefined) {
      this.db
        .prepare('UPDATE steps SET attempt = ? WHERE step_id = ?')
        .run(updates.attempt, stepId);
    }

    const result = await this.getStep(stepId);
    if (!result) throw new Error(`Step not found: ${stepId}`);
    return result;
  }

  async listSteps(runId: string): Promise<Step[]> {
    const rows = this.db
      .prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY sequence ASC')
      .all(runId) as Record<string, unknown>[];
    return Promise.resolve(rows.map((row) => this.rowToStep(row)));
  }

  async recordOutcome(outcome: OutcomeRecord): Promise<OutcomeRecord> {
    this.db
      .prepare(
        `INSERT INTO outcomes (outcome_id, step_id, operation_type, operation_key, result, token_input, token_output, duration_ms, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        outcome.outcomeId,
        outcome.stepId,
        outcome.operationType,
        outcome.operationKey,
        Buffer.from(serialize(outcome.result)),
        outcome.tokens.inputTokens,
        outcome.tokens.outputTokens,
        outcome.durationMs,
        outcome.recordedAt.toISOString(),
      );
    return Promise.resolve(outcome);
  }

  async getOutcome(outcomeId: string): Promise<OutcomeRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM outcomes WHERE outcome_id = ?')
      .get(outcomeId) as Record<string, unknown> | undefined;
    if (!row) return Promise.resolve(null);
    return Promise.resolve(this.rowToOutcome(row));
  }

  async getOutcomeByKey(operationKey: string): Promise<OutcomeRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM outcomes WHERE operation_key = ?')
      .get(operationKey) as Record<string, unknown> | undefined;
    if (!row) return Promise.resolve(null);
    return Promise.resolve(this.rowToOutcome(row));
  }

  async listOutcomes(stepId: string): Promise<OutcomeRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM outcomes WHERE step_id = ?')
      .all(stepId) as Record<string, unknown>[];
    return Promise.resolve(rows.map((row) => this.rowToOutcome(row)));
  }

  async updateHeartbeat(runId: string): Promise<void> {
    this.db
      .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
      .run(new Date().toISOString(), runId);
    return Promise.resolve();
  }

  async findStaleRuns(timeoutMs: number): Promise<ExecutionRun[]> {
    const threshold = new Date(Date.now() - timeoutMs).toISOString();
    const rows = this.db
      .prepare(
        "SELECT * FROM runs WHERE status = 'running' AND last_heartbeat < ?",
      )
      .all(threshold) as Record<string, unknown>[];
    return Promise.resolve(rows.map((row) => this.rowToRun(row)));
  }

  async deleteRunsOlderThan(maxAgeMs: number): Promise<number> {
    const threshold = new Date(Date.now() - maxAgeMs).toISOString();
    const result = this.db
      .prepare('DELETE FROM runs WHERE created_at < ?')
      .run(threshold);
    return Promise.resolve(result.changes);
  }

  close(): void {
    this.db.close();
  }

  private rowToRun(row: Record<string, unknown>): ExecutionRun {
    return {
      runId: row.run_id as string,
      status: row.status as ExecutionRun['status'],
      config: deserialize<RunConfig>(row.config as string),
      metadata: deserialize<Record<string, unknown>>(row.metadata as string),
      totals: {
        cost: row.total_cost as number,
        tokens: row.total_tokens as number,
        steps: row.total_steps as number,
        recoveryCount: row.recovery_count as number,
      },
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      lastHeartbeat: new Date(row.last_heartbeat as string),
    };
  }

  private rowToStep(row: Record<string, unknown>): Step {
    return {
      stepId: row.step_id as string,
      runId: row.run_id as string,
      nodeName: row.node_name as string,
      sequence: row.sequence as number,
      status: row.status as Step['status'],
      startedAt: new Date(row.started_at as string),
      completedAt: row.completed_at
        ? new Date(row.completed_at as string)
        : undefined,
      inputStateHash: (row.input_state_hash as string) ?? undefined,
      cost: {
        inputTokens: row.cost_input_tokens as number,
        outputTokens: row.cost_output_tokens as number,
        costUsd: row.cost_usd as number,
      },
      attempt: row.attempt as number,
    };
  }

  private rowToOutcome(row: Record<string, unknown>): OutcomeRecord {
    const resultRaw = row.result;
    const resultStr = Buffer.isBuffer(resultRaw)
      ? resultRaw.toString()
      : (resultRaw as string);

    return {
      outcomeId: row.outcome_id as string,
      stepId: row.step_id as string,
      operationType: row.operation_type as OutcomeRecord['operationType'],
      operationKey: row.operation_key as string,
      result: deserialize(resultStr),
      tokens: {
        inputTokens: row.token_input as number,
        outputTokens: row.token_output as number,
        costUsd: 0,
      },
      durationMs: row.duration_ms as number,
      recordedAt: new Date(row.recorded_at as string),
    };
  }
}

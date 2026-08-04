import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { randomUUID } from 'node:crypto';
import type { JournalStore, ListRunsFilter } from './interface.js';
import type {
  ExecutionRun,
  OutcomeRecord,
  RunConfig,
  Step,
} from '../core/types.js';
import { serialize, deserialize } from '../serialization/serializer.js';

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  config TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  total_cost DOUBLE PRECISION DEFAULT 0,
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
  cost_usd DOUBLE PRECISION DEFAULT 0,
  attempt INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS outcomes (
  outcome_id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  result BYTEA NOT NULL,
  token_input INTEGER DEFAULT 0,
  token_output INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outcomes_opkey ON outcomes(operation_key);
CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, last_heartbeat);
`;

export class PostgresJournalStore implements JournalStore {
  private pool: Pool;

  constructor(config: PoolConfig) {
    this.pool = new Pool(config);
  }

  async migrate(): Promise<void> {
    await this.pool.query(MIGRATION_SQL);
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

    await this.pool.query(
      `INSERT INTO runs (run_id, status, config, metadata, total_cost, total_tokens, total_steps, recovery_count, created_at, updated_at, last_heartbeat)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
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
      ],
    );

    return run;
  }

  async getRun(runId: string): Promise<ExecutionRun | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM runs WHERE run_id = $1',
      [runId],
    );
    if (rows.length === 0) return null;
    return this.rowToRun(rows[0]);
  }

  async updateRun(
    runId: string,
    updates: Partial<Pick<ExecutionRun, 'status' | 'metadata' | 'totals'>>,
  ): Promise<ExecutionRun> {
    const existing = await this.getRun(runId);
    if (!existing) throw new Error(`Run not found: ${runId}`);

    const now = new Date();
    if (updates.status !== undefined) {
      await this.pool.query(
        'UPDATE runs SET status = $1, updated_at = $2 WHERE run_id = $3',
        [updates.status, now.toISOString(), runId],
      );
    }
    if (updates.metadata !== undefined) {
      await this.pool.query(
        'UPDATE runs SET metadata = $1, updated_at = $2 WHERE run_id = $3',
        [serialize(updates.metadata), now.toISOString(), runId],
      );
    }
    if (updates.totals !== undefined) {
      await this.pool.query(
        'UPDATE runs SET total_cost = $1, total_tokens = $2, total_steps = $3, recovery_count = $4, updated_at = $5 WHERE run_id = $6',
        [
          updates.totals.cost,
          updates.totals.tokens,
          updates.totals.steps,
          updates.totals.recoveryCount,
          now.toISOString(),
          runId,
        ],
      );
    }

    return (await this.getRun(runId))!;
  }

  async listRuns(filter?: ListRunsFilter): Promise<ExecutionRun[]> {
    let sql = 'SELECT * FROM runs';
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filter?.status) {
      sql += ` WHERE status = $${paramIdx}`;
      paramIdx++;
      params.push(filter.status);
    }
    sql += ' ORDER BY created_at DESC';
    if (filter?.limit) {
      sql += ` LIMIT $${paramIdx}`;
      paramIdx++;
      params.push(filter.limit);
    }
    if (filter?.offset) {
      sql += ` OFFSET $${paramIdx}`;
      params.push(filter.offset);
    }

    const { rows } = await this.pool.query(sql, params);
    return rows.map((row: Record<string, unknown>) => this.rowToRun(row));
  }

  async deleteRun(runId: string): Promise<void> {
    await this.pool.query('DELETE FROM runs WHERE run_id = $1', [runId]);
  }

  async createStep(step: Omit<Step, 'completedAt'>): Promise<Step> {
    await this.pool.query(
      `INSERT INTO steps (step_id, run_id, node_name, sequence, status, started_at, input_state_hash, cost_input_tokens, cost_output_tokens, cost_usd, attempt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
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
      ],
    );
    return { ...step, completedAt: undefined };
  }

  async getStep(stepId: string): Promise<Step | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM steps WHERE step_id = $1',
      [stepId],
    );
    if (rows.length === 0) return null;
    return this.rowToStep(rows[0]);
  }

  async updateStep(
    stepId: string,
    updates: Partial<Pick<Step, 'status' | 'completedAt' | 'cost' | 'attempt'>>,
  ): Promise<Step> {
    if (updates.status !== undefined) {
      await this.pool.query(
        'UPDATE steps SET status = $1 WHERE step_id = $2',
        [updates.status, stepId],
      );
    }
    if (updates.completedAt !== undefined) {
      await this.pool.query(
        'UPDATE steps SET completed_at = $1 WHERE step_id = $2',
        [updates.completedAt.toISOString(), stepId],
      );
    }
    if (updates.cost !== undefined) {
      await this.pool.query(
        'UPDATE steps SET cost_input_tokens = $1, cost_output_tokens = $2, cost_usd = $3 WHERE step_id = $4',
        [
          updates.cost.inputTokens,
          updates.cost.outputTokens,
          updates.cost.costUsd,
          stepId,
        ],
      );
    }
    if (updates.attempt !== undefined) {
      await this.pool.query(
        'UPDATE steps SET attempt = $1 WHERE step_id = $2',
        [updates.attempt, stepId],
      );
    }

    const result = await this.getStep(stepId);
    if (!result) throw new Error(`Step not found: ${stepId}`);
    return result;
  }

  async listSteps(runId: string): Promise<Step[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM steps WHERE run_id = $1 ORDER BY sequence ASC',
      [runId],
    );
    return rows.map((row: Record<string, unknown>) => this.rowToStep(row));
  }

  async recordOutcome(outcome: OutcomeRecord): Promise<OutcomeRecord> {
    await this.pool.query(
      `INSERT INTO outcomes (outcome_id, step_id, operation_type, operation_key, result, token_input, token_output, duration_ms, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        outcome.outcomeId,
        outcome.stepId,
        outcome.operationType,
        outcome.operationKey,
        Buffer.from(serialize(outcome.result)),
        outcome.tokens.inputTokens,
        outcome.tokens.outputTokens,
        outcome.durationMs,
        outcome.recordedAt.toISOString(),
      ],
    );
    return outcome;
  }

  async getOutcome(outcomeId: string): Promise<OutcomeRecord | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM outcomes WHERE outcome_id = $1',
      [outcomeId],
    );
    if (rows.length === 0) return null;
    return this.rowToOutcome(rows[0]);
  }

  async getOutcomeByKey(operationKey: string): Promise<OutcomeRecord | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM outcomes WHERE operation_key = $1',
      [operationKey],
    );
    if (rows.length === 0) return null;
    return this.rowToOutcome(rows[0]);
  }

  async listOutcomes(stepId: string): Promise<OutcomeRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM outcomes WHERE step_id = $1',
      [stepId],
    );
    return rows.map((row: Record<string, unknown>) => this.rowToOutcome(row));
  }

  async updateHeartbeat(runId: string): Promise<void> {
    await this.pool.query(
      'UPDATE runs SET last_heartbeat = $1 WHERE run_id = $2',
      [new Date().toISOString(), runId],
    );
  }

  async findStaleRuns(timeoutMs: number): Promise<ExecutionRun[]> {
    const threshold = new Date(Date.now() - timeoutMs).toISOString();
    const { rows } = await this.pool.query(
      "SELECT * FROM runs WHERE status = 'running' AND last_heartbeat < $1",
      [threshold],
    );
    return rows.map((row: Record<string, unknown>) => this.rowToRun(row));
  }

  async deleteRunsOlderThan(maxAgeMs: number): Promise<number> {
    const threshold = new Date(Date.now() - maxAgeMs).toISOString();
    const result = await this.pool.query(
      'DELETE FROM runs WHERE created_at < $1',
      [threshold],
    );
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
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

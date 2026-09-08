import type {
  ExecutionRun,
  OutcomeRecord,
  RecoveryClaim,
  RunConfig,
  RunStatus,
  Step,
} from '../core/types.js';

export interface ListRunsFilter {
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

export interface JournalStore {
  /** Generates runId, sets initial timestamps, zeroes totals. */
  createRun(config: RunConfig): Promise<ExecutionRun>;

  getRun(runId: string): Promise<ExecutionRun | null>;

  /**
   * Only status, metadata, totals are mutable. Also bumps updatedAt.
   * Fenced: the write applies only while the run's persisted recovery_generation
   * equals expectedGeneration; otherwise throws DurableError('FENCED').
   */
  updateRun(
    runId: string,
    updates: Partial<Pick<ExecutionRun, 'status' | 'metadata' | 'totals'>>,
    expectedGeneration: number,
  ): Promise<ExecutionRun>;

  /** Newest first. */
  listRuns(filter?: ListRunsFilter): Promise<ExecutionRun[]>;

  /** Cascading — also removes all steps and outcomes for this run. */
  deleteRun(runId: string): Promise<void>;

  /**
   * Fenced: applies only while the owning run's persisted recovery_generation
   * equals expectedGeneration; otherwise throws DurableError('FENCED').
   */
  createStep(
    step: Omit<Step, 'completedAt'>,
    expectedGeneration: number,
  ): Promise<Step>;

  getStep(stepId: string): Promise<Step | null>;

  /**
   * Fenced: applies only while the owning run's persisted recovery_generation
   * equals expectedGeneration; otherwise throws DurableError('FENCED').
   */
  updateStep(
    stepId: string,
    updates: Partial<Pick<Step, 'status' | 'completedAt' | 'cost' | 'attempt'>>,
    expectedGeneration: number,
  ): Promise<Step>;

  /** Ordered by sequence ascending. */
  listSteps(runId: string): Promise<Step[]>;

  /**
   * Fenced: applies only while the owning run's (resolved from step_id)
   * persisted recovery_generation equals expectedGeneration; otherwise throws
   * DurableError('FENCED').
   */
  recordOutcome(
    outcome: OutcomeRecord,
    expectedGeneration: number,
  ): Promise<OutcomeRecord>;

  getOutcome(outcomeId: string): Promise<OutcomeRecord | null>;

  /** Primary replay lookup — if key exists, reuse the cached result. */
  getOutcomeByKey(operationKey: string): Promise<OutcomeRecord | null>;

  listOutcomes(stepId: string): Promise<OutcomeRecord[]>;

  /**
   * Sets lastHeartbeat to now. Called periodically to signal liveness.
   * Fenced: applies only while the run's persisted recovery_generation equals
   * expectedGeneration. Returns true if applied, false if fenced (does NOT throw).
   */
  updateHeartbeat(runId: string, expectedGeneration: number): Promise<boolean>;

  /** Considers runs with 'running' or 'recovering' status and an expired heartbeat. */
  findStaleRuns(timeoutMs: number): Promise<ExecutionRun[]>;

  /**
   * Atomically claim a stale run for recovery. Single-statement CAS that flips
   * the run into 'recovering', advances recovery_generation by +1, and stamps a
   * fresh ownerToken. Returns a RecoveryClaim carrying the new generation the
   * caller must hold for all subsequent writes; returns null when the CAS does
   * not match (the run is terminal, or another worker raced ahead).
   */
  claimRunForRecovery(runId: string): Promise<RecoveryClaim | null>;

  /** Cascading delete of runs older than maxAgeMs (by createdAt). */
  deleteRunsOlderThan(maxAgeMs: number): Promise<number>;
}

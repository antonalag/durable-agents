import type {
  ExecutionRun,
  OutcomeRecord,
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

  /** Only status, metadata, totals are mutable. Also bumps updatedAt. */
  updateRun(
    runId: string,
    updates: Partial<Pick<ExecutionRun, 'status' | 'metadata' | 'totals'>>,
  ): Promise<ExecutionRun>;

  /** Newest first. */
  listRuns(filter?: ListRunsFilter): Promise<ExecutionRun[]>;

  /** Cascading — also removes all steps and outcomes for this run. */
  deleteRun(runId: string): Promise<void>;

  createStep(step: Omit<Step, 'completedAt'>): Promise<Step>;

  getStep(stepId: string): Promise<Step | null>;

  updateStep(
    stepId: string,
    updates: Partial<Pick<Step, 'status' | 'completedAt' | 'cost' | 'attempt'>>,
  ): Promise<Step>;

  /** Ordered by sequence ascending. */
  listSteps(runId: string): Promise<Step[]>;

  recordOutcome(outcome: OutcomeRecord): Promise<OutcomeRecord>;

  getOutcome(outcomeId: string): Promise<OutcomeRecord | null>;

  /** Primary replay lookup — if key exists, reuse the cached result. */
  getOutcomeByKey(operationKey: string): Promise<OutcomeRecord | null>;

  listOutcomes(stepId: string): Promise<OutcomeRecord[]>;

  /** Sets lastHeartbeat to now. Called periodically to signal liveness. */
  updateHeartbeat(runId: string): Promise<void>;

  /** Only considers runs with 'running' status. */
  findStaleRuns(timeoutMs: number): Promise<ExecutionRun[]>;

  /** Cascading delete of runs older than maxAgeMs (by createdAt). */
  deleteRunsOlderThan(maxAgeMs: number): Promise<number>;
}

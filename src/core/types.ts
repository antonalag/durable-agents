export type RunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stale'
  | 'terminated';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export type OperationType = 'llm_call' | 'tool_call' | 'custom';

export interface TokenCost {
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost in USD. */
  costUsd: number;
}

export interface BudgetConfig {
  /** Agent terminates gracefully when exceeded. */
  maxCostUsd?: number;
  maxSteps?: number;
  maxDurationMs?: number;
  /** Fraction (0-1) at which a warning event fires. Default: 0.8 */
  warningThreshold?: number;
}

export interface RunConfig {
  /** Unique name identifying this workflow definition. */
  name: string;
  maxSteps?: number;
  budget?: BudgetConfig;
  /** Default: 10000 (10s). */
  heartbeatIntervalMs?: number;
  /** Runs without a heartbeat for this long are considered stale. Default: 30000 (30s). */
  staleTimeoutMs?: number;
  /** Automatically recover stale runs on startup. */
  autoRecover?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Step {
  stepId: string;
  runId: string;
  nodeName: string;
  /** 0-indexed position within the run. */
  sequence: number;
  status: StepStatus;
  startedAt: Date;
  completedAt?: Date;
  /** SHA-256 of the input state — used for idempotency during replay. */
  inputStateHash?: string;
  cost: TokenCost;
  attempt: number;
}

export interface OutcomeRecord {
  outcomeId: string;
  stepId: string;
  operationType: OperationType;
  /** SHA-256 based. If this key exists during replay, skip re-execution. */
  operationKey: string;
  result: unknown;
  tokens: TokenCost;
  durationMs: number;
  recordedAt: Date;
}

export interface ExecutionRun {
  runId: string;
  status: RunStatus;
  config: RunConfig;
  metadata: Record<string, unknown>;
  totals: {
    cost: number;
    tokens: number;
    steps: number;
    recoveryCount: number;
  };
  createdAt: Date;
  updatedAt: Date;
  /** Used for stale detection — runtime updates this periodically. */
  lastHeartbeat: Date;
}

export interface BaseEvent {
  timestamp: Date;
  runId: string;
}

export interface RunStartedEvent extends BaseEvent {
  type: 'run:started';
  config: RunConfig;
}

export interface RunCompletedEvent extends BaseEvent {
  type: 'run:completed';
  result: unknown;
  totals: ExecutionRun['totals'];
}

export interface RunFailedEvent extends BaseEvent {
  type: 'run:failed';
  error: Error;
  lastCompletedStep?: number;
}

export interface RunRecoveredEvent extends BaseEvent {
  type: 'run:recovered';
  recoveredFromStep: number;
  totalStepsRecovered: number;
}

export interface StepStartedEvent extends BaseEvent {
  type: 'step:started';
  stepId: string;
  nodeName: string;
  sequence: number;
}

export interface StepCompletedEvent extends BaseEvent {
  type: 'step:completed';
  stepId: string;
  nodeName: string;
  sequence: number;
  cost: TokenCost;
  durationMs: number;
}

export interface BudgetWarningEvent extends BaseEvent {
  type: 'budget:warning';
  currentCost: number;
  budgetLimit: number;
  /** 0-1 fraction consumed. */
  percentUsed: number;
}

export interface BudgetExceededEvent extends BaseEvent {
  type: 'budget:exceeded';
  currentCost: number;
  budgetLimit: number;
  action: 'graceful_stop' | 'terminate';
}

export interface LoopDetectedEvent extends BaseEvent {
  type: 'loop:detected';
  loopType: 'same_tool' | 'no_progress' | 'oscillation';
  detectedAtStep: number;
  repetitions: number;
}

export type DurableEvent =
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunRecoveredEvent
  | StepStartedEvent
  | StepCompletedEvent
  | BudgetWarningEvent
  | BudgetExceededEvent
  | LoopDetectedEvent;

export type EventMap = {
  'run:started': RunStartedEvent;
  'run:completed': RunCompletedEvent;
  'run:failed': RunFailedEvent;
  'run:recovered': RunRecoveredEvent;
  'step:started': StepStartedEvent;
  'step:completed': StepCompletedEvent;
  'budget:warning': BudgetWarningEvent;
  'budget:exceeded': BudgetExceededEvent;
  'loop:detected': LoopDetectedEvent;
};

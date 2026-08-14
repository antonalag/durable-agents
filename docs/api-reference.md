# API Reference

Complete reference for all public exports from `durable-agents`.

---

## Classes

### DurableWorkflow

Main orchestrator that runs a workflow function with step-level journaling, budget enforcement, loop detection, and heartbeat-based stale detection.

```ts
class DurableWorkflow<TInput, TOutput> {
  readonly name: string;
  readonly eventBus: EventBus;

  constructor(name: string, fn: WorkflowFn<TInput, TOutput>, opts: DurableWorkflowOptions);

  on<K extends keyof EventMap>(type: K, handler: (event: EventMap[K]) => void): void;
  off<K extends keyof EventMap>(type: K, handler: (event: EventMap[K]) => void): void;
  run(input: TInput, options?: { signal?: AbortSignal }): Promise<TOutput>;
  terminate(runId: string, reason: string): void;
}
```

**Parameters (constructor):**

| Param | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique workflow name |
| `fn` | `WorkflowFn<TInput, TOutput>` | Async function receiving `(ctx, input)` |
| `opts` | `DurableWorkflowOptions` | Store, budget, loop, heartbeat config |

**Usage:**

```ts
import { DurableWorkflow, SqliteJournalStore } from 'durable-agents';

const store = new SqliteJournalStore(':memory:');
const workflow = new DurableWorkflow('research', async (ctx, input: string) => {
  const data = await ctx.step('fetch', () => fetchData(input));
  return ctx.step('summarize', () => summarize(data));
}, { store });

const result = await workflow.run('quantum computing');
```

---

### DurableContextImpl

Execution context passed to workflow functions. Provides `step`, `parallel`, and `idempotent` primitives that journal outcomes for replay on crash recovery.

```ts
class DurableContextImpl {
  readonly run: ExecutionRun;
  readonly signal: AbortSignal;

  constructor(opts: DurableContextOptions);

  step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  parallel<T>(steps: Array<{ name: string; fn: () => T | Promise<T> }>): Promise<T[]>;
  idempotent<T>(operationKey: string, fn: () => T | Promise<T>): Promise<T>;
}
```

**Usage:**

```ts
// Inside a workflow function:
const result = await ctx.step('analyze', () => analyzeData(input));
const [a, b] = await ctx.parallel([
  { name: 'taskA', fn: () => doA() },
  { name: 'taskB', fn: () => doB() },
]);
```

---

### RecoveryEngine

Detects stale runs and replays them from the journal without re-executing completed steps.

```ts
class RecoveryEngine {
  constructor(store: JournalStore, eventBus: EventBus, staleTimeoutMs: number);

  detectStaleRuns(): Promise<ExecutionRun[]>;
  recover<TInput, TOutput>(runId: string, fn: WorkflowFn<TInput, TOutput>, input: TInput): Promise<TOutput>;
}
```

**Parameters (constructor):**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `store` | `JournalStore` | — | Persistence backend |
| `eventBus` | `EventBus` | — | Event emitter for recovery events |
| `staleTimeoutMs` | `number` | — | Heartbeat silence threshold (ms) |

**Usage:**

```ts
import { RecoveryEngine, EventBus, SqliteJournalStore } from 'durable-agents';

const engine = new RecoveryEngine(store, new EventBus(), 30_000);
const stale = await engine.detectStaleRuns();
for (const run of stale) {
  await engine.recover(run.runId, workflowFn, run.metadata.input);
}
```

---

### EventBus

Typed pub/sub for lifecycle events. Used internally by `DurableWorkflow` and exposed for custom monitoring.

```ts
class EventBus {
  on<K extends keyof EventMap>(type: K, handler: (event: EventMap[K]) => void): void;
  off<K extends keyof EventMap>(type: K, handler: (event: EventMap[K]) => void): void;
  emit<K extends keyof EventMap>(type: K, event: EventMap[K]): void;
}
```

**Usage:**

```ts
import { EventBus } from 'durable-agents';

const bus = new EventBus();
bus.on('step:completed', (event) => {
  console.log(`Step ${event.nodeName} completed in ${event.durationMs}ms`);
});
```

---

### Heartbeat

Periodically updates `lastHeartbeat` on a run to signal liveness. Used by the runtime to detect stale runs.

```ts
class Heartbeat {
  constructor(store: JournalStore, runId: string, intervalMs: number);

  start(): void;
  stop(): void;
  isRunning(): boolean;
}
```

**Usage:**

```ts
import { Heartbeat } from 'durable-agents';

const heartbeat = new Heartbeat(store, run.runId, 10_000);
heartbeat.start();
// ... do work ...
heartbeat.stop();
```

---

### SqliteJournalStore

SQLite-backed `JournalStore` using `better-sqlite3`. Good for development and single-process production.

```ts
class SqliteJournalStore implements JournalStore {
  constructor(filePath: string);
}
```

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `filePath` | `string` | Path to SQLite file, or `':memory:'` for in-memory |

**Usage:**

```ts
import { SqliteJournalStore } from 'durable-agents';

const store = new SqliteJournalStore('./journal.db');
```

---

### PostgresJournalStore

PostgreSQL-backed `JournalStore` using `pg.Pool`. Suited for multi-process and production deployments.

```ts
class PostgresJournalStore implements JournalStore {
  constructor(config: PoolConfig);
}
```

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `config` | `PoolConfig` (from `pg`) | PostgreSQL connection pool configuration |

**Usage:**

```ts
import { PostgresJournalStore } from 'durable-agents';

const store = new PostgresJournalStore({
  connectionString: process.env.DATABASE_URL,
});
```

---

## Functions

### checkBudget

Evaluates current run totals against budget limits. Returns status (`ok`, `warning`, `exceeded`) and which limit triggered.

```ts
function checkBudget(input: BudgetCheckInput): BudgetCheckResult;
```

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `input.totals` | `{ cost: number; tokens: number; steps: number }` | Current usage totals |
| `input.elapsedMs` | `number` | Elapsed wall-clock time |
| `input.config` | `BudgetConfig \| undefined` | Budget limits |

**Returns:** `BudgetCheckResult` — `{ status, triggeredBy?, percentUsed }`

**Usage:**

```ts
import { checkBudget } from 'durable-agents';

const result = checkBudget({
  totals: { cost: 0.08, tokens: 5000, steps: 4 },
  elapsedMs: 12000,
  config: { maxCostUsd: 0.10, warningThreshold: 0.8 },
});
// result.status === 'warning', result.triggeredBy === 'maxCostUsd'
```

---

### detectLoop

Analyzes step history for repetitive patterns: same-tool repetition, no-progress, and oscillation.

```ts
function detectLoop(history: readonly StepRecord[], config: LoopConfig | undefined): LoopDetectionResult;
```

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `history` | `readonly StepRecord[]` | Recent step records with `nodeName`, `sequence`, `outputHash?` |
| `config` | `LoopConfig \| undefined` | Detection thresholds |

**Returns:** `LoopDetectionResult` — `{ detected, loopType?, repetitions?, action? }`

**Usage:**

```ts
import { detectLoop } from 'durable-agents';

const result = detectLoop(stepHistory, {
  windowSize: 10,
  maxRepetitions: 3,
  action: 'graceful_stop',
});
if (result.detected) console.log(`Loop: ${result.loopType}`);
```

---

### idempotent

At-most-once execution wrapper for tool calls. Computes a deterministic operation key from the run, tool name, and args — if already recorded, returns the cached result.

```ts
function idempotent<TArgs, TResult>(
  ctx: DurableContextImpl,
  toolName: string,
  args: TArgs,
  fn: () => Promise<TResult>,
): Promise<TResult>;
```

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `ctx` | `DurableContextImpl` | Current execution context |
| `toolName` | `string` | Unique tool identifier |
| `args` | `TArgs` | Tool arguments (used for key computation) |
| `fn` | `() => Promise<TResult>` | Function to execute (skipped on cache hit) |

**Returns:** `Promise<TResult>`

**Usage:**

```ts
import { idempotent } from 'durable-agents';

const result = await idempotent(ctx, 'web-search', { query: 'AI agents' }, async () => {
  return await searchWeb('AI agents');
});
```

---

### serialize / deserialize

Type-preserving serialization using SuperJSON. Handles `Date`, `Map`, `Set`, `Buffer`, `BigInt`, etc.

```ts
function serialize(value: unknown): string;
function deserialize<T = unknown>(serialized: string): T;
```

**Usage:**

```ts
import { serialize, deserialize } from 'durable-agents';

const json = serialize({ date: new Date(), map: new Map([['a', 1]]) });
const restored = deserialize(json);
// restored.date instanceof Date === true
```

---

### computeOperationKey

Generates a deterministic SHA-256 hex key from any number of inputs. Used internally to produce stable operation keys for idempotency and replay.

```ts
function computeOperationKey(...inputs: unknown[]): string;
```

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `...inputs` | `unknown[]` | Any serializable values (order matters) |

**Returns:** `string` — 64-char hex SHA-256 hash

**Usage:**

```ts
import { computeOperationKey } from 'durable-agents';

const key = computeOperationKey('run-123', 'search', { query: 'test' });
// '8a3f...' (deterministic for same inputs)
```

---

### validateRunConfig

Validates a workflow configuration. Throws `DurableError` with code `'INVALID_CONFIG'` on validation failures.

```ts
function validateRunConfig(config: {
  name: string;
  heartbeatIntervalMs?: number;
  staleTimeoutMs?: number;
  budget?: BudgetConfig;
  loopDetection?: LoopConfig;
}): void;
```

**Throws:** `DurableError` if:
- `name` is empty
- `heartbeatIntervalMs >= staleTimeoutMs`
- Budget or loop detection values are out of range

**Usage:**

```ts
import { validateRunConfig } from 'durable-agents';

validateRunConfig({
  name: 'my-workflow',
  heartbeatIntervalMs: 5000,
  staleTimeoutMs: 30000,
  budget: { maxCostUsd: 1.0 },
});
```

---

### withTimeout

Wraps a promise with a timeout. Rejects with `Error('Summary step timeout')` if the promise doesn't settle within `ms`.

```ts
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>;
```

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `promise` | `Promise<T>` | Promise to race against timeout |
| `ms` | `number` | Timeout in milliseconds |

**Returns:** `Promise<T>`

**Usage:**

```ts
import { withTimeout } from 'durable-agents';

const result = await withTimeout(fetchData(), 5000);
```

---

## Types and Interfaces

### RunConfig

Configuration for a workflow run.

```ts
interface RunConfig {
  name: string;
  maxSteps?: number;
  budget?: BudgetConfig;
  loopDetection?: LoopConfig;
  heartbeatIntervalMs?: number;   // Default: 10000
  staleTimeoutMs?: number;        // Default: 30000
  autoRecover?: boolean;
  metadata?: Record<string, unknown>;
}
```

---

### BudgetConfig

Cost, step, and duration limits for a run.

```ts
interface BudgetConfig {
  maxCostUsd?: number;
  maxSteps?: number;
  maxDurationMs?: number;
  warningThreshold?: number;  // Default: 0.8 (fires warning at 80%)
}
```

---

### LoopConfig

Thresholds for loop detection patterns.

```ts
interface LoopConfig {
  windowSize?: number;           // Default: 10
  maxRepetitions?: number;       // Default: 3
  maxNoProgressSteps?: number;   // Default: 4
  action?: 'graceful_stop' | 'emit_only';  // Default: 'graceful_stop'
}
```

---

### ExecutionRun

Represents a workflow execution with its current state and cumulative totals.

```ts
interface ExecutionRun {
  runId: string;
  status: RunStatus;
  config: RunConfig;
  metadata: Record<string, unknown>;
  totals: { cost: number; tokens: number; steps: number; recoveryCount: number };
  createdAt: Date;
  updatedAt: Date;
  lastHeartbeat: Date;
}

type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stale' | 'terminated';
```

---

### Step

An individual step within a run.

```ts
interface Step {
  stepId: string;
  runId: string;
  nodeName: string;
  sequence: number;
  status: StepStatus;
  startedAt: Date;
  completedAt?: Date;
  inputStateHash?: string;
  cost: TokenCost;
  attempt: number;
}

type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
```

---

### OutcomeRecord

Cached result of an operation, keyed by operation key for replay.

```ts
interface OutcomeRecord {
  outcomeId: string;
  stepId: string;
  operationType: OperationType;
  operationKey: string;
  result: unknown;
  tokens: TokenCost;
  durationMs: number;
  recordedAt: Date;
}

type OperationType = 'llm_call' | 'tool_call' | 'custom';
```

---

### TokenCost

Token usage and estimated cost for a single operation.

```ts
interface TokenCost {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
```

---

### JournalStore

Persistence interface for runs, steps, and outcomes. Implement this to add a custom backend.

```ts
interface JournalStore {
  createRun(config: RunConfig): Promise<ExecutionRun>;
  getRun(runId: string): Promise<ExecutionRun | null>;
  updateRun(runId: string, updates: Partial<Pick<ExecutionRun, 'status' | 'metadata' | 'totals'>>): Promise<ExecutionRun>;
  listRuns(filter?: ListRunsFilter): Promise<ExecutionRun[]>;
  deleteRun(runId: string): Promise<void>;

  createStep(step: Omit<Step, 'completedAt'>): Promise<Step>;
  getStep(stepId: string): Promise<Step | null>;
  updateStep(stepId: string, updates: Partial<Pick<Step, 'status' | 'completedAt' | 'cost' | 'attempt'>>): Promise<Step>;
  listSteps(runId: string): Promise<Step[]>;

  recordOutcome(outcome: OutcomeRecord): Promise<OutcomeRecord>;
  getOutcome(outcomeId: string): Promise<OutcomeRecord | null>;
  getOutcomeByKey(operationKey: string): Promise<OutcomeRecord | null>;
  listOutcomes(stepId: string): Promise<OutcomeRecord[]>;

  updateHeartbeat(runId: string): Promise<void>;
  findStaleRuns(timeoutMs: number): Promise<ExecutionRun[]>;
  deleteRunsOlderThan(maxAgeMs: number): Promise<number>;
}
```

---

### DurableEvent / EventMap

Union of all lifecycle events and the typed event map.

```ts
type DurableEvent =
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunRecoveredEvent
  | StepStartedEvent
  | StepCompletedEvent
  | BudgetWarningEvent
  | BudgetExceededEvent
  | LoopDetectedEvent;

type EventMap = {
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
```

---

### DurableWorkflowOptions

Options for the `DurableWorkflow` constructor.

```ts
interface DurableWorkflowOptions {
  store: JournalStore;
  heartbeatIntervalMs?: number;   // Default: 10000
  staleTimeoutMs?: number;        // Default: 30000
  autoRecover?: boolean;
  eventBus?: EventBus;
  budget?: BudgetConfig;
  loopDetection?: LoopConfig;
}
```

---

### WorkflowFn

The signature for a workflow function.

```ts
type WorkflowFn<TInput, TOutput> = (ctx: DurableContextImpl, input: TInput) => Promise<TOutput>;
```

---

### RunPhase / TerminationReason

Lifecycle phase and termination reason for active runs.

```ts
type RunPhase = 'running' | 'stopping' | 'terminated';
type TerminationReason = 'budget_exceeded' | 'loop_detected' | 'kill_switch';
```

---

### BudgetStatus / BudgetCheckInput / BudgetCheckResult

Types used by `checkBudget`.

```ts
type BudgetStatus = 'ok' | 'warning' | 'exceeded';

interface BudgetCheckInput {
  totals: { cost: number; tokens: number; steps: number };
  elapsedMs: number;
  config: BudgetConfig | undefined;
}

interface BudgetCheckResult {
  status: BudgetStatus;
  triggeredBy?: 'maxCostUsd' | 'maxSteps' | 'maxDurationMs';
  percentUsed: number;
}
```

---

### LoopType / LoopAction / StepRecord / LoopDetectionResult

Types used by `detectLoop`.

```ts
type LoopType = 'same_tool' | 'no_progress' | 'oscillation';
type LoopAction = 'graceful_stop' | 'emit_only';

interface StepRecord {
  nodeName: string;
  sequence: number;
  outputHash?: string;
}

interface LoopDetectionResult {
  detected: boolean;
  loopType?: LoopType;
  repetitions?: number;
  action?: LoopAction;
}
```

---

## Errors

### DurableError

Base error class with a machine-readable `code` field.

```ts
class DurableError extends Error {
  readonly code: DurableErrorCode;
  readonly cause?: Error;

  constructor(code: DurableErrorCode, message: string, options?: { cause?: Error });
  toJSON(): { code: string; message: string; cause?: string };
}

type DurableErrorCode =
  | 'BUDGET_EXCEEDED'
  | 'LOOP_DETECTED'
  | 'RUN_TERMINATED'
  | 'STORE_ERROR'
  | 'INVALID_CONFIG'
  | 'DASHBOARD_PORT_IN_USE';
```

**Usage:**

```ts
import { DurableWorkflow, DurableError } from 'durable-agents';

try {
  await workflow.run(input);
} catch (err) {
  if (err instanceof DurableError) {
    console.error(`[${err.code}] ${err.message}`);
  }
}
```

---

### DurableAdapterError

Error thrown by framework adapters for adapter-specific failures.

```ts
class DurableAdapterError extends Error {
  readonly adapter: 'langgraph' | 'ai-sdk';
  readonly code: string;

  constructor(message: string, adapter: 'langgraph' | 'ai-sdk', code: string);
}
```

---

### PeerDependencyError

Thrown when a required peer dependency for an adapter is missing.

```ts
class PeerDependencyError extends DurableAdapterError {
  constructor(packageName: string, minVersion: string, adapter: 'langgraph' | 'ai-sdk');
}
```

**Usage:**

```ts
import { PeerDependencyError } from 'durable-agents';

try {
  const { createDurableMiddleware } = await import('durable-agents/langgraph');
} catch (err) {
  if (err instanceof PeerDependencyError) {
    console.error(err.message);
    // "durable-agents/langgraph requires "@langchain/langgraph" (>=0.2.0)..."
  }
}
```

---

## Subpath Exports

### `durable-agents/langgraph`

LangGraph.js framework adapter. Requires `@langchain/langgraph` >= 0.2.0 as a peer dependency.

```ts
import { createDurableMiddleware, extractLangGraphTokens } from 'durable-agents/langgraph';
```

#### createDurableMiddleware

Creates a middleware object with `beforeAgent`, `afterModel`, and `afterAgent` hooks for LangGraph integration.

```ts
function createDurableMiddleware(options: LangGraphDurableOptions): DurableMiddleware;

interface LangGraphDurableOptions {
  store: JournalStore;
  config: RunConfig;
  eventBus?: EventBus;
}
```

**Usage:**

```ts
import { createDurableMiddleware } from 'durable-agents/langgraph';
import { SqliteJournalStore } from 'durable-agents';

const store = new SqliteJournalStore('./journal.db');
const middleware = createDurableMiddleware({
  store,
  config: { name: 'research-agent' },
});
```

#### extractLangGraphTokens

Extracts token usage from a LangGraph model response.

```ts
function extractLangGraphTokens(response: unknown): TokenCost;
```

---

### `durable-agents/ai-sdk`

Vercel AI SDK adapter. Requires `ai` >= 4.0.0 as a peer dependency.

```ts
import { withDurability, extractAiSdkTokens } from 'durable-agents/ai-sdk';
```

#### withDurability

Wraps an AI SDK call with outcome journaling. Skips re-execution on recovery if the operation key is already recorded.

```ts
function withDurability<T>(
  durableCtx: AiSdkDurableContext,
  name: string,
  fn: () => Promise<T>,
): Promise<T>;

interface AiSdkDurableContext {
  store: JournalStore;
  ctx: DurableContextImpl;
  eventBus: EventBus;
}
```

**Usage:**

```ts
import { withDurability } from 'durable-agents/ai-sdk';

const result = await withDurability(durableCtx, 'generate-summary', async () => {
  return await generateText({ model, prompt });
});
```

#### extractAiSdkTokens

Extracts token usage from an AI SDK response.

```ts
function extractAiSdkTokens(response: unknown): TokenCost;
```

---

### `durable-agents/dashboard`

Web dashboard for inspecting runs, steps, and live events.

```ts
import { startDashboard } from 'durable-agents/dashboard';
```

#### startDashboard

Starts the Hono web server with SSE live updates.

```ts
function startDashboard(options: DashboardOptions): Promise<DashboardServer>;

interface DashboardOptions {
  store: JournalStore;
  port?: number;        // Default: 3100
  eventBus?: EventBus;
}

interface DashboardServer {
  port: number;
  close(): Promise<void>;
}
```

**Usage:**

```ts
import { startDashboard } from 'durable-agents/dashboard';
import { SqliteJournalStore } from 'durable-agents';

const store = new SqliteJournalStore('./journal.db');
const server = await startDashboard({ store, port: 3100 });
// Dashboard at http://localhost:3100
await server.close();
```

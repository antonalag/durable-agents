# Lifecycle Controls Guide

durable-agents ships with built-in safeguards that prevent autonomous agents from running up costs, looping forever, or becoming unresponsive. This guide covers budget enforcement, loop detection, the kill switch, graceful stop, and the event hooks that let you monitor everything in real time.

## Budget Enforcement

Budget enforcement sets hard limits on cost, step count, and wall-clock time. It runs **before every step** — if a limit is exceeded, the workflow transitions to a graceful stop.

### BudgetConfig

```typescript
import { DurableWorkflow } from 'durable-agents';

const workflow = new DurableWorkflow('my-agent', agentFn, {
  store,
  budget: {
    maxCostUsd: 0.50,       // stop after $0.50 spent
    maxSteps: 20,           // stop after 20 steps
    maxDurationMs: 60_000,  // stop after 60 seconds
    warningThreshold: 0.8,  // emit warning at 80% usage (default)
  },
});
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxCostUsd` | `number \| undefined` | — | Maximum cumulative USD cost |
| `maxSteps` | `number \| undefined` | — | Maximum total step count |
| `maxDurationMs` | `number \| undefined` | — | Maximum wall-clock time from run start |
| `warningThreshold` | `number` | `0.8` | Fraction (0–1) at which a `budget:warning` event fires |

### How It Works

1. Before each step, `checkBudget` evaluates all configured limits against current totals.
2. When any metric crosses `warningThreshold` (default 80%), the runtime emits a `budget:warning` event. The warning fires once per metric.
3. When any metric reaches or exceeds its limit, the runtime emits `budget:exceeded` and triggers a **graceful stop** — the agent gets one final summary step before termination.

### BudgetCheckResult

`checkBudget` returns a structured result:

```typescript
interface BudgetCheckResult {
  status: 'ok' | 'warning' | 'exceeded';
  triggeredBy?: 'maxCostUsd' | 'maxSteps' | 'maxDurationMs';
  percentUsed: number;
}
```

The `triggeredBy` field tells you which limit caused the highest usage. When multiple limits are configured, the worst status wins.

## Loop Detection

Loop detection analyzes recent step history **after each step** to catch agents stuck in repetitive patterns.

### LoopConfig

```typescript
const workflow = new DurableWorkflow('research-agent', agentFn, {
  store,
  loopDetection: {
    windowSize: 10,          // analyze last 10 steps
    maxRepetitions: 3,       // flag after 3+ consecutive repetitions
    maxNoProgressSteps: 4,   // flag after 4 steps with identical output
    action: 'graceful_stop', // trigger graceful stop (default)
  },
});
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `windowSize` | `number` | `10` | Number of recent steps to analyze |
| `maxRepetitions` | `number` | `3` | Consecutive same-tool calls before flagging |
| `maxNoProgressSteps` | `number` | `4` | Consecutive identical-output steps before flagging |
| `action` | `'graceful_stop' \| 'emit_only'` | `'graceful_stop'` | What to do when a loop is detected |

### Detection Types

The detector checks three patterns in order:

#### 1. Same Tool (`same_tool`)

The agent is calling the same tool over and over. Detected when the last N consecutive steps all have the same node name, where N exceeds `maxRepetitions`.

```
step: search → search → search → search  ← flagged (4 > 3)
```

#### 2. No Progress (`no_progress`)

The agent is executing steps but producing identical outputs. Detected when the last `maxNoProgressSteps` steps all have the same output hash.

```
step: analyze (hash: abc) → refine (hash: abc) → retry (hash: abc) → check (hash: abc)  ← flagged
```

#### 3. Oscillation (`oscillation`)

The agent is bouncing between two tools in an A-B-A-B pattern. Detected when alternating pairs exceed `maxRepetitions`.

```
step: search → summarize → search → summarize → search → summarize → search → summarize  ← flagged
```

### Post-Step Analysis

After each step completes, the runtime:

1. Records the step's node name and output hash in the history window
2. Calls `detectLoop` with the window and config
3. If a loop is detected, emits a `loop:detected` event
4. If `action` is `'graceful_stop'`, transitions the run to stopping phase
5. If `action` is `'emit_only'`, the event fires but execution continues

## Kill Switch

For situations that need immediate termination — no summary step, no cleanup.

```typescript
workflow.terminate(runId, 'User requested abort');
```

### Behavior

- The run is **immediately aborted** via `AbortController`
- No final summary step is executed
- The run status is set to `'terminated'` in the store
- The termination reason is recorded in run metadata as `terminationReason: 'kill_switch'` with a `terminationDetail` field containing your reason string
- Active heartbeats are cleaned up

### When to Use

Kill switch is for emergency situations:
- The agent is producing harmful output
- A deployment rollback needs to stop all in-flight runs
- The user explicitly cancels via UI

For non-emergency stops where you want a clean summary, use graceful stop instead.

## Graceful Stop

Graceful stop gives the agent one final chance to produce a summary before shutting down. It's triggered automatically by budget enforcement and loop detection, but you can also trigger it programmatically.

### State Machine

```
running → stopping → terminated
```

1. **running** — Normal execution. Steps execute as usual.
2. **stopping** — The next step call is allowed (the "summary step") but no steps after that.
3. **terminated** — Execution is complete. No more steps are allowed.

### How It Works

1. When a graceful stop is triggered (budget exceeded or loop detected), the lifecycle phase transitions from `running` to `stopping`.
2. The next `ctx.step()` call is permitted — this is the summary step. The agent can use it to save progress, write a summary, or notify the user.
3. The summary step has a **30-second timeout**. If it exceeds this, it's forcibly terminated.
4. After the summary step completes (or times out), the phase transitions to `terminated`.
5. Any subsequent `ctx.step()` calls throw an `AbortError`.
6. The termination reason (`'budget_exceeded'` or `'loop_detected'`) is recorded in run metadata.

### Summary Step Timeout

The 30-second timeout (`SUMMARY_STEP_TIMEOUT_MS`) prevents a misbehaving summary step from hanging forever:

```typescript
// Internally, the runtime wraps the summary step:
const result = await withTimeout(originalStep(name, fn), 30_000);
```

If the timeout fires, the step throws and the run moves to `terminated` status.

## Configuration Examples

### Chatbot with Budget Only

A customer-facing chatbot where you want to cap costs but loops aren't a concern (human drives conversation):

```typescript
const chatbot = new DurableWorkflow('support-bot', handleChat, {
  store,
  budget: {
    maxCostUsd: 1.00,
    maxSteps: 50,
    warningThreshold: 0.9, // warn late since human is driving
  },
});
```

### Autonomous Agent with Loop Detection

A research agent that runs unsupervised — loops are the primary risk:

```typescript
const researcher = new DurableWorkflow('researcher', researchFn, {
  store,
  loopDetection: {
    windowSize: 8,
    maxRepetitions: 3,
    maxNoProgressSteps: 3,
    action: 'graceful_stop',
  },
});
```

### Both Controls Combined

Production agent with full protection:

```typescript
const agent = new DurableWorkflow('prod-agent', agentFn, {
  store,
  budget: {
    maxCostUsd: 2.00,
    maxSteps: 100,
    maxDurationMs: 300_000, // 5 minutes
    warningThreshold: 0.8,
  },
  loopDetection: {
    windowSize: 10,
    maxRepetitions: 3,
    maxNoProgressSteps: 4,
    action: 'graceful_stop',
  },
});

// Monitor events
agent.on('budget:warning', (e) => {
  console.warn(`Budget ${(e.percentUsed * 100).toFixed(0)}% used`);
});

agent.on('loop:detected', (e) => {
  console.warn(`Loop detected: ${e.loopType} at step ${e.detectedAtStep}`);
});
```

### Emit-Only Loop Detection (Monitoring Without Stopping)

If you want visibility into loops without stopping the agent (useful during development):

```typescript
const dev = new DurableWorkflow('dev-agent', agentFn, {
  store,
  loopDetection: {
    windowSize: 10,
    maxRepetitions: 5, // higher tolerance
    action: 'emit_only', // don't stop, just emit event
  },
});

dev.on('loop:detected', (e) => {
  // Log it, send to monitoring, but don't interrupt
  metrics.increment('agent.loop_detected', { type: e.loopType });
});
```

## Event Hooks

All lifecycle control events are emitted through the workflow's typed `EventBus`. Subscribe with `workflow.on()`.

### `budget:warning`

Fired when a budget metric crosses the warning threshold. Fires once per metric.

```typescript
interface BudgetWarningEvent {
  type: 'budget:warning';
  timestamp: Date;
  runId: string;
  currentCost: number;
  budgetLimit: number;
  percentUsed: number; // 0–1 fraction
}
```

```typescript
workflow.on('budget:warning', (event) => {
  slack.send(`⚠️ Agent ${event.runId} at ${(event.percentUsed * 100).toFixed(0)}% budget`);
});
```

### `budget:exceeded`

Fired when a budget metric reaches its limit. The workflow will begin graceful stop.

```typescript
interface BudgetExceededEvent {
  type: 'budget:exceeded';
  timestamp: Date;
  runId: string;
  currentCost: number;
  budgetLimit: number;
  action: 'graceful_stop' | 'terminate';
}
```

```typescript
workflow.on('budget:exceeded', (event) => {
  logger.error(`Run ${event.runId} exceeded budget: $${event.currentCost}/$${event.budgetLimit}`);
});
```

### `loop:detected`

Fired when the loop detector identifies a repetitive pattern.

```typescript
interface LoopDetectedEvent {
  type: 'loop:detected';
  timestamp: Date;
  runId: string;
  loopType: 'same_tool' | 'no_progress' | 'oscillation';
  detectedAtStep: number;
  repetitions: number;
}
```

```typescript
workflow.on('loop:detected', (event) => {
  logger.warn(
    `Loop: ${event.loopType} detected at step ${event.detectedAtStep} ` +
    `(${event.repetitions} repetitions)`
  );
});
```

### Subscribing and Unsubscribing

```typescript
// Subscribe
const handler = (e: BudgetWarningEvent) => console.log(e);
workflow.on('budget:warning', handler);

// Unsubscribe when no longer needed
workflow.off('budget:warning', handler);
```

### All Available Events

For completeness, the full event map also includes runtime lifecycle events:

| Event | When |
|-------|------|
| `run:started` | A new run begins |
| `run:completed` | A run finishes successfully |
| `run:failed` | A run fails with an error |
| `run:recovered` | A stale run is recovered from journal |
| `step:started` | A step begins execution |
| `step:completed` | A step finishes (includes cost and duration) |
| `budget:warning` | A budget metric crosses the warning threshold |
| `budget:exceeded` | A budget metric is exceeded (graceful stop begins) |
| `loop:detected` | A repetitive pattern is identified |

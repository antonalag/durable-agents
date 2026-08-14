# Adapters Guide

durable-agents ships framework adapters that bridge your agent framework's execution model to the durable runtime. Each adapter is a thin layer that journals outcomes, tracks tokens, and enables crash recovery — without changing your framework's programming model.

## Architecture Overview

Adapters follow a simple principle: wrap framework-specific call patterns and delegate persistence to `DurableContextImpl`.

```
┌─────────────────────────────────────────────────┐
│            Your Agent Framework                  │
│  (LangGraph.js, AI SDK, or custom)              │
└─────────────┬───────────────────────────────────┘
              │  hooks / wrappers
┌─────────────▼───────────────────────────────────┐
│          Framework Adapter                       │
│  durable-agents/langgraph | durable-agents/ai-sdk│
└─────────────┬───────────────────────────────────┘
              │  step(), idempotent(), recordOutcome()
┌─────────────▼───────────────────────────────────┐
│        DurableContextImpl + JournalStore         │
│  Outcome journaling, replay, operation keys     │
└─────────────────────────────────────────────────┘
```

### Subpath Exports

Each adapter lives in its own subpath export so tree-shaking works and framework-specific peer dependencies are only checked when you actually import the adapter:

```ts
import { createDurableMiddleware } from 'durable-agents/langgraph';
import { withDurability } from 'durable-agents/ai-sdk';
import { idempotent } from 'durable-agents'; // framework-agnostic
```

This means your bundle only includes the adapter code you use.

---

## LangGraph.js Integration

The LangGraph adapter provides `createDurableMiddleware` — a function that returns lifecycle hooks you plug into your LangGraph.js agent graph.

### Import

```ts
import { createDurableMiddleware } from 'durable-agents/langgraph';
```

### API

```ts
function createDurableMiddleware(options: LangGraphDurableOptions): DurableMiddleware;

interface LangGraphDurableOptions {
  store: JournalStore;      // SQLite or PostgreSQL journal store
  config: RunConfig;        // Workflow name, heartbeat, budget, etc.
  eventBus?: EventBus;      // Optional — uses internal bus if omitted
}

interface DurableMiddleware {
  beforeAgent: () => Promise<void>;
  afterModel: (ctx: { step: Step; response: unknown }) => Promise<void>;
  afterAgent: (ctx: { result: unknown; totals: ExecutionRun['totals'] }) => Promise<void>;
}
```

### Hooks

| Hook | When it fires | What it does |
|------|---------------|--------------|
| `beforeAgent` | Before the graph starts | Detects stale runs, loads replay cursor, creates a new run, starts heartbeat |
| `afterModel` | After each LLM node completes | Records outcome to journal (or replays from cache during recovery) |
| `afterAgent` | After the full graph finishes | Stops heartbeat, marks run as completed, emits `run:completed` |

### Token Extraction

The adapter auto-extracts tokens from LangGraph responses via `usage_metadata`:

```ts
// LangGraph model responses include usage_metadata:
// { input_tokens: 150, output_tokens: 42 }
// The adapter reads these and records them in the journal.
```

### Recovery Flow

1. `beforeAgent` checks for stale runs matching the workflow name
2. If found, it loads all completed step outcomes into a replay cursor
3. During execution, `afterModel` checks the cursor — if a matching operation key exists, it skips journaling (already recovered)
4. Once the cursor is exhausted, the adapter switches to fresh mode and emits `run:recovered`

### Full Example

```ts
import { createDurableMiddleware } from 'durable-agents/langgraph';
import { SqliteJournalStore, EventBus } from 'durable-agents';

// 1. Set up persistence
const store = new SqliteJournalStore('./research-agent.db');
const eventBus = new EventBus();

// 2. Create the middleware
const middleware = createDurableMiddleware({
  store,
  config: {
    name: 'research-agent',
    heartbeatIntervalMs: 10_000,
    staleTimeoutMs: 30_000,
  },
  eventBus,
});

// 3. In your LangGraph graph, call the hooks at the right points:

// Before invoking the graph:
await middleware.beforeAgent();

// After each model node returns a response:
await middleware.afterModel({
  step: { stepId: 'step-1', nodeName: 'search', /* ... */ },
  response: modelResponse,
});

// After the full graph completes:
await middleware.afterAgent({
  result: finalOutput,
  totals: { steps: 4, cost: 0.02, inputTokens: 600, outputTokens: 180 },
});

// 4. Listen for lifecycle events
eventBus.on('run:started', (e) => console.log(`Run ${e.runId} started`));
eventBus.on('run:recovered', (e) =>
  console.log(`Recovered ${e.totalStepsRecovered} steps from journal`)
);
eventBus.on('run:completed', (e) => console.log(`Run completed: ${e.totals.steps} steps`));
```

In a real LangGraph.js project with `@langchain/langgraph` installed, you'd wire these hooks into your `StateGraph`:

```ts
import { StateGraph } from '@langchain/langgraph';
import { createDurableMiddleware } from 'durable-agents/langgraph';
import { SqliteJournalStore } from 'durable-agents';

const store = new SqliteJournalStore('./agent.db');

const { beforeAgent, afterModel, afterAgent } = createDurableMiddleware({
  store,
  config: { name: 'my-research-agent', heartbeatIntervalMs: 10_000, staleTimeoutMs: 30_000 },
});

const graph = new StateGraph(AgentState)
  .addNode('search', async (state) => {
    const result = await searchTool(state.query);
    await afterModel({ step: { stepId: 'auto', nodeName: 'search' }, response: result });
    return { ...state, searchResults: result };
  })
  .addNode('summarize', async (state) => {
    const result = await llm.invoke(state.searchResults);
    await afterModel({ step: { stepId: 'auto', nodeName: 'summarize' }, response: result });
    return { ...state, summary: result };
  })
  .compile();

// Run with durability
await beforeAgent();
const result = await graph.invoke({ query: 'durable execution patterns' });
await afterAgent({ result, totals: { steps: 2, cost: 0, inputTokens: 0, outputTokens: 0 } });
```

---

## AI SDK Integration

The AI SDK adapter provides `withDurability` — a wrapper that records outcomes for `generateText` or `streamText` calls and replays them on recovery.

### Import

```ts
import { withDurability } from 'durable-agents/ai-sdk';
```

### API

```ts
async function withDurability<T>(
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

### How it works

1. Computes an operation key from the run ID and step name
2. Checks the journal for an existing outcome — if found, returns it immediately (recovery path)
3. If no cached outcome, executes `fn()`, extracts token usage from the AI SDK response format (`usage.promptTokens`, `usage.completionTokens`), and journals the result
4. On crash + restart, the same call returns the journaled result without hitting the LLM

### Token Accounting

The adapter reads the AI SDK's standard response shape:

```ts
// AI SDK responses include:
// { usage: { promptTokens: 150, completionTokens: 45 } }
// These are recorded in the journal for cost tracking.
```

If the response doesn't include usage data, the adapter emits an `adapter:warning` event.

### Full Example

```ts
import { withDurability } from 'durable-agents/ai-sdk';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import {
  DurableWorkflow,
  SqliteJournalStore,
  EventBus,
  DurableContextImpl,
} from 'durable-agents';

const store = new SqliteJournalStore('./tool-agent.db');
const eventBus = new EventBus();

const workflow = new DurableWorkflow(
  'planning-agent',
  async (ctx, input: { task: string }) => {
    // Wrap each LLM call with withDurability.
    // On recovery, this returns the journaled result — no LLM call, no cost.
    const plan = await withDurability({ store, ctx, eventBus }, 'generate-plan', () =>
      generateText({
        model: openai('gpt-4o'),
        prompt: `Create a plan for: ${input.task}`,
      })
    );

    const review = await withDurability({ store, ctx, eventBus }, 'review-plan', () =>
      generateText({
        model: openai('gpt-4o'),
        prompt: `Review this plan: ${plan.text}`,
      })
    );

    return { plan: plan.text, review: review.text };
  },
  { store, eventBus },
);

// If this crashes after 'generate-plan' completes,
// restarting replays that step from journal — zero extra LLM cost.
const result = await workflow.run({ task: 'Build a REST API' });
```

---

## Idempotent Tool Decorator

The `idempotent` function guarantees at-most-once execution for side-effecting tool calls. It works with any framework — LangGraph, AI SDK, or standalone.

### Import

```ts
import { idempotent } from 'durable-agents';
```

### API

```ts
function idempotent<TArgs, TResult>(
  ctx: DurableContextImpl,
  toolName: string,
  args: TArgs,
  fn: () => Promise<TResult>,
): Promise<TResult>;
```

### How it works

1. Computes a deterministic operation key from `(runId, toolName, args)` using SHA-256
2. Checks the journal — if an outcome with that key exists, returns the stored result immediately
3. If no stored outcome, executes `fn()`, records the result, and returns it
4. On subsequent calls with the same args (or after crash recovery), the tool function never re-executes

This is critical for side-effecting operations like sending webhooks, charging credit cards, or writing to external APIs where double-execution causes real problems.

### Example

```ts
import { DurableWorkflow, SqliteJournalStore, idempotent } from 'durable-agents';

const store = new SqliteJournalStore('./agent.db');

const workflow = new DurableWorkflow(
  'notification-agent',
  async (ctx, input: { userId: string; message: string }) => {
    // This webhook fires AT MOST ONCE, even if:
    // - The agent crashes and recovers
    // - The LLM calls this tool multiple times with the same args
    const result = await idempotent(
      ctx,
      'send-notification',
      { userId: input.userId, message: input.message },
      async () => {
        const res = await fetch('https://api.example.com/notify', {
          method: 'POST',
          body: JSON.stringify({ to: input.userId, text: input.message }),
        });
        return res.json();
      },
    );

    console.log(`Notification sent: ${result.id}`);
    return result;
  },
  { store },
);

await workflow.run({ userId: 'user-123', message: 'Your report is ready' });
```

### Using with AI SDK

```ts
import { withDurability } from 'durable-agents/ai-sdk';
import { idempotent } from 'durable-agents';

// Inside a workflow:
async (ctx, input) => {
  // LLM call — journaled for replay
  const plan = await withDurability({ store, ctx, eventBus }, 'plan', () =>
    generateText({ model, prompt: input.task })
  );

  // Tool call — idempotent (at-most-once)
  const webhook = await idempotent(ctx, 'notify', { msg: plan.text }, () =>
    sendWebhook(plan.text)
  );
};
```

### Using with LangGraph

```ts
import { createDurableMiddleware } from 'durable-agents/langgraph';
import { idempotent } from 'durable-agents';

// Inside a graph node:
async function executeToolNode(state, ctx) {
  // The tool only fires once per unique (runId + toolName + args) combination
  const result = await idempotent(ctx, 'database-write', state.payload, () =>
    db.insert(state.payload)
  );
  return { ...state, writeResult: result };
}
```

---

## Standalone Usage

You don't need any framework adapter to use durable-agents. The core API — `DurableWorkflow` with `ctx.step()` and `ctx.parallel()` — gives you full crash recovery without LangGraph or AI SDK.

### When to use standalone

- Your agent doesn't use a supported framework
- You're building a custom orchestration loop
- You want maximum control over step boundaries

### Example

```ts
import { DurableWorkflow, SqliteJournalStore, EventBus } from 'durable-agents';

const store = new SqliteJournalStore('./workflow.db');

const workflow = new DurableWorkflow(
  'data-pipeline',
  async (ctx, input: { url: string }) => {
    // Each ctx.step() call is journaled. On crash + restart,
    // completed steps return their stored result instantly.
    const data = await ctx.step('fetch', async () => {
      const res = await fetch(input.url);
      return res.json();
    });

    const transformed = await ctx.step('transform', () => {
      return data.items.map((item: any) => ({ ...item, processed: true }));
    });

    // Parallel steps run concurrently, each journaled independently
    const [validated, enriched] = await ctx.parallel([
      { name: 'validate', fn: () => validateSchema(transformed) },
      { name: 'enrich', fn: () => addMetadata(transformed) },
    ]);

    const saved = await ctx.step('save', () =>
      db.insertMany(enriched)
    );

    return { count: saved.length, valid: validated.passed };
  },
  {
    store,
    heartbeatIntervalMs: 10_000,
    staleTimeoutMs: 30_000,
    autoRecover: true, // Automatically recovers stale runs on startup
  },
);

// Event hooks for observability
workflow.on('run:started', (e) => console.log(`Started: ${e.runId}`));
workflow.on('step:completed', (e) => console.log(`Step done: ${e.nodeName}`));
workflow.on('run:completed', (e) => console.log(`Finished: ${e.totals.steps} steps`));

const result = await workflow.run({ url: 'https://api.example.com/data' });
```

### Key DurableContextImpl primitives

| Method | Purpose |
|--------|---------|
| `ctx.step(name, fn)` | Execute a named step. Journaled on completion, replayed on recovery. |
| `ctx.parallel(steps)` | Execute multiple steps concurrently. Each is journaled independently. |
| `ctx.idempotent(key, fn)` | At-most-once execution keyed by operation key. |
| `ctx.run` | Access the current `ExecutionRun` (ID, status, totals). |
| `ctx.signal` | `AbortSignal` for cooperative cancellation. |

---

## Peer Dependency Handling

Framework adapters declare their framework packages as **optional peer dependencies**. This means:

- Installing `durable-agents` alone works fine for standalone usage
- Framework packages are only required when you import a specific adapter subpath

### What's declared

```json
{
  "peerDependencies": {
    "@langchain/core": ">=0.3.0",
    "@langchain/langgraph": ">=0.2.0",
    "ai": ">=4.0.0"
  },
  "peerDependenciesMeta": {
    "@langchain/langgraph": { "optional": true },
    "@langchain/core": { "optional": true },
    "ai": { "optional": true }
  }
}
```

### What happens when a framework isn't installed

When you import an adapter subpath without the required peer dependency, the adapter throws a `PeerDependencyError` at call time with a clear install instruction:

```ts
import { createDurableMiddleware } from 'durable-agents/langgraph';

// If @langchain/langgraph is not installed:
const middleware = createDurableMiddleware({ store, config });
// throws: PeerDependencyError:
//   durable-agents/langgraph requires "@langchain/langgraph" (>=0.2.0).
//   Install it with: npm install @langchain/langgraph
```

### Handling the error

```ts
import { PeerDependencyError } from 'durable-agents';

try {
  const { createDurableMiddleware } = await import('durable-agents/langgraph');
  const middleware = createDurableMiddleware({ store, config });
} catch (err) {
  if (err instanceof PeerDependencyError) {
    console.error(err.message);
    // "durable-agents/langgraph requires "@langchain/langgraph" (>=0.2.0).
    //  Install it with: npm install @langchain/langgraph"
    process.exit(1);
  }
  throw err;
}
```

### Installing only what you need

```bash
# Core only (standalone workflows, no framework adapter)
npm install durable-agents

# With LangGraph.js support
npm install durable-agents @langchain/langgraph @langchain/core

# With Vercel AI SDK support
npm install durable-agents ai

# Both frameworks
npm install durable-agents @langchain/langgraph @langchain/core ai
```

The `idempotent` function is exported from the main `durable-agents` package and has no peer dependency requirements — it works everywhere.

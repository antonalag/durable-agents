[![CI](https://github.com/antonalag/durable-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/antonalag/durable-agents/actions/workflows/ci.yml)

# durable-agents

Open-source durable execution runtime for AI agents — crash recovery, outcome journaling, and idempotent operations.

## Status

🚧 **In development** — all sprints complete, preparing for v0.1.0 launch.

## What's done

- ✅ SQLite and PostgreSQL journal stores (full CRUD, cascading deletes, TTL cleanup)
- ✅ Type-preserving serialization (Date, Map, Set, Buffer, BigInt)
- ✅ Deterministic operation keys (SHA-256, order-independent)
- ✅ Durable runtime engine (DurableWorkflow, DurableContext, RecoveryEngine)
- ✅ Crash recovery with outcome replay (steps replay from journal, no duplicate side effects)
- ✅ Heartbeat-based stale detection and auto-recovery
- ✅ Parallel step execution with partial failure handling
- ✅ Idempotent operations (`ctx.idempotent(key, fn)`)
- ✅ Typed EventBus for lifecycle events
- ✅ LangGraph.js adapter (`createDurableMiddleware`) with crash recovery
- ✅ Vercel AI SDK adapter (`withDurability`) with token accounting
- ✅ Standalone idempotent tool decorator (framework-agnostic)
- ✅ Subpath exports (`durable-agents/langgraph`, `durable-agents/ai-sdk`)
- ✅ Optional peer dependencies (works without frameworks installed)
- ✅ Budget enforcement (`checkBudget`) — cost, steps, and duration limits
- ✅ Loop detection (`detectLoop`) — same-tool, no-progress, oscillation
- ✅ Kill switch API (`workflow.terminate(runId, reason)`)
- ✅ Graceful stop — one final summary step before termination
- ✅ Web dashboard (`startDashboard`) — Hono server with htmx and SSE live updates
- ✅ CLI (`npx durable-agents dashboard`, `npx durable-agents recover`)
- ✅ Typed error hierarchy (`DurableError` with machine-readable codes)
- ✅ Event hooks API (`workflow.on()` / `workflow.off()`)
- ✅ Configuration validation at construction time
- ✅ Core bundle: 27.77 KB minified (< 50 KB gate)
- ✅ Property-based testing with fast-check (324 tests, 34 correctness properties)

## What's next

- 🔜 Documentation site and API reference
- 🔜 Live demo and example agents
- 🔜 npm publish (v0.1.0)

## Install

```bash
npm install durable-agents
```

> **Note:** The package is not yet published to npm. This will happen at v0.1.0 release.

## Quick Start

```typescript
import { DurableWorkflow, SqliteJournalStore } from 'durable-agents';

const store = new SqliteJournalStore('./agent.db');

const workflow = new DurableWorkflow('my-agent', async (ctx, input) => {
  const research = await ctx.step('research', () => searchWeb(input.query));
  const analysis = await ctx.step('analyze', () => analyzeResults(research));
  return analysis;
}, {
  store,
  budget: { maxCostUsd: 5.0, maxSteps: 50 },
  loopDetection: { maxRepetitions: 3 },
});

// Runs with journaling, budget limits, and loop detection
// If it crashes, it resumes from last completed step
const result = await workflow.run({ query: 'durable execution patterns' });
```

### Event Hooks

```typescript
workflow.on('run:completed', (event) => {
  console.log(`Run ${event.runId} done, cost: $${event.totals.cost}`);
});

workflow.on('budget:warning', (event) => {
  console.log(`Budget ${(event.percentUsed * 100).toFixed(0)}% consumed`);
});
```

### With LangGraph.js

```typescript
import { createDurableMiddleware } from 'durable-agents/langgraph';
import { SqliteJournalStore } from 'durable-agents';

const store = new SqliteJournalStore('./agent.db');
const middleware = createDurableMiddleware({
  store,
  config: { name: 'research-agent' },
});
```

### With Vercel AI SDK

```typescript
import { withDurability } from 'durable-agents/ai-sdk';

const result = await withDurability({ store, ctx, eventBus }, 'generate', () =>
  generateText({ model, prompt: 'Hello' })
);
```

### Dashboard

```typescript
import { startDashboard } from 'durable-agents/dashboard';

const server = await startDashboard({ store, port: 3100 });
// Open http://localhost:3100 for real-time run monitoring
```

### Kill Switch

```typescript
workflow.terminate(runId, 'User requested stop');
```

### CLI

```bash
# Start the monitoring dashboard
npx durable-agents dashboard --port 3100

# Scan and recover stale runs
npx durable-agents recover --db ./agent.db
```

## License

MIT

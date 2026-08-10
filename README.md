[![CI](https://github.com/antonalag/durable-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/antonalag/durable-agents/actions/workflows/ci.yml)

# durable-agents

Open-source durable execution runtime for AI agents — crash recovery, outcome journaling, and idempotent operations.

## Status

🚧 **In development** — lifecycle controls complete, dashboard and polish next.

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
- ✅ Budget enforcement (`checkBudget`) — cost, steps, and duration limits with warning threshold
- ✅ Loop detection (`detectLoop`) — same-tool repetition, no-progress, and oscillation patterns
- ✅ Kill switch API (`workflow.terminate(runId, reason)`) — immediate external termination
- ✅ Graceful stop — one final summary step before termination on budget/loop triggers
- ✅ Property-based testing with fast-check (236+ tests, 23 correctness properties)

## What's next

- 🔜 Dashboard server and CLI tooling
- 🔜 Documentation site and API reference
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

### With LangGraph.js

```typescript
import { createDurableMiddleware } from 'durable-agents/langgraph';
import { SqliteJournalStore } from 'durable-agents';

const store = new SqliteJournalStore('./agent.db');
const middleware = createDurableMiddleware({
  store,
  config: { name: 'research-agent' },
});

// Use middleware hooks with your LangGraph agent
```

### With Vercel AI SDK

```typescript
import { withDurability } from 'durable-agents/ai-sdk';
import { SqliteJournalStore } from 'durable-agents';

const store = new SqliteJournalStore('./agent.db');

// Wrap AI SDK calls for durable journaling
const result = await withDurability({ store, ctx, eventBus }, 'generate', () =>
  generateText({ model, prompt: 'Hello' })
);
```

### Kill Switch

```typescript
// Terminate a running workflow externally
workflow.terminate(runId, 'User requested stop');
```

## License

MIT

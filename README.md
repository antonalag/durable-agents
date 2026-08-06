[![CI](https://github.com/antonalag/durable-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/antonalag/durable-agents/actions/workflows/ci.yml)

# durable-agents

Open-source durable execution runtime for AI agents — crash recovery, outcome journaling, and idempotent operations.

## Status

🚧 **In development** — runtime core complete, framework adapters next.

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
- ✅ Property-based testing with fast-check (126+ tests, 8 correctness properties)

## What's next

- 🔜 LangGraph.js and Vercel AI SDK adapters
- 🔜 Budget enforcement and loop detection
- 🔜 Dashboard and CLI tooling

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
}, { store });

// Runs with journaling — if it crashes, it resumes from last completed step
const result = await workflow.run({ query: 'durable execution patterns' });
```

## License

MIT

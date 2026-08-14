## durable-agents v0.1.0

First public release of the durable execution runtime for AI agents.

### Highlights

- **Crash recovery** — resume from last completed step, zero re-execution, zero wasted LLM calls
- **Framework adapters** — first-class LangGraph.js and Vercel AI SDK integration
- **Lifecycle controls** — budget enforcement, loop detection, kill switch with graceful stop
- **Web dashboard** — real-time monitoring with SSE live updates
- **27.8 KB** core bundle, **324 tests**, **34 property-based correctness proofs**

### Features

#### Runtime
- `DurableWorkflow` — step-level journaling with automatic outcome recording
- `ctx.step()` — sequential durable steps with replay on recovery
- `ctx.parallel()` — concurrent steps with partial failure handling
- `RecoveryEngine` — heartbeat-based stale detection + automated recovery
- `EventBus` — typed pub/sub for all lifecycle events
- `SqliteJournalStore` — zero-config SQLite persistence (WAL mode)
- `PostgresJournalStore` — production-grade PostgreSQL persistence
- Type-preserving serialization (Date, Map, Set, Buffer, BigInt)
- Deterministic operation keys (SHA-256)

#### Adapters
- `createDurableMiddleware` — LangGraph.js lifecycle hooks (beforeAgent, afterModel, afterAgent)
- `withDurability` — Vercel AI SDK wrapper with token accounting
- `idempotent()` — framework-agnostic at-most-once tool decorator
- Subpath exports: `durable-agents/langgraph`, `durable-agents/ai-sdk`
- Optional peer dependencies (works without frameworks installed)

#### Lifecycle Controls
- `checkBudget` — cost, steps, and duration limits with warning threshold
- `detectLoop` — same-tool, no-progress, and oscillation pattern detection
- `workflow.terminate(runId, reason)` — kill switch with immediate abort
- Graceful stop — one final summary step before termination
- Typed `DurableError` with machine-readable codes

#### Dashboard & CLI
- `startDashboard({ store, port })` — Hono web server with htmx
- Runs list with sorting and filtering
- Run detail page with step timeline and recovery indicators
- SSE endpoint for real-time event streaming
- `npx durable-agents dashboard` — start dashboard from CLI
- `npx durable-agents recover` — scan and recover stale runs

#### Developer Experience
- `workflow.on()` / `workflow.off()` — event hooks API
- `validateRunConfig()` — descriptive config validation at construction time
- Core bundle: 27.8 KB minified (tree-shakeable)
- 324 tests across 56 files with 34 fast-check correctness properties

### Installation

```bash
npm install durable-agents
```

### Links

- [Getting Started](./docs/getting-started.md)
- [Core Concepts](./docs/concepts.md)
- [API Reference](./docs/api-reference.md)
- [Examples](./examples/)
- [GitHub Repository](https://github.com/antonalag/durable-agents)

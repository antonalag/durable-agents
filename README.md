[![CI](https://github.com/antonalag/durable-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/antonalag/durable-agents/actions/workflows/ci.yml)

# durable-agents

Open-source durable execution runtime for AI agents — crash recovery, outcome journaling, and idempotent operations.

## Status

🚧 **In development** — persistence layer complete, runtime core next.

## What's done

- ✅ SQLite and PostgreSQL journal stores (full CRUD, cascading deletes, TTL cleanup)
- ✅ Type-preserving serialization (Date, Map, Set, Buffer, BigInt)
- ✅ Deterministic operation keys (SHA-256, order-independent)
- ✅ Shared test suite with property-based testing (81 tests, 13 correctness properties)

## What's next

- 🔜 Runtime core with crash recovery and outcome replay
- 🔜 LangGraph.js and Vercel AI SDK adapters
- 🔜 Budget enforcement and loop detection

## Install

```bash
npm install durable-agents
```

> **Note:** The package is not yet published to npm. This will happen at v0.1.0 release.

## License

MIT

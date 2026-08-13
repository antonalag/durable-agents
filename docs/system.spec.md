# System Spec — durable-agents

## Project Identity
- **Name:** durable-agents
- **Repo:** [github.com/antonalag/durable-agents](https://github.com/antonalag/durable-agents)
- **Pitch:** Open-source durable execution runtime for AI agents — crash recovery, outcome journaling, and idempotent operations.
- **License:** MIT
- **Language:** TypeScript (Node.js 20+)
- **Timeline:** 12 weeks, 2-week sprints

---

## Current Status

| Field | Value |
|-------|-------|
| **Active Sprint** | Sprint 5 — Dashboard + CLI + Polish ✅ COMPLETE |
| **Sprint Start** | 2026-08-10 |
| **Sprint End** | 2026-08-13 |
| **Milestone** | Hono dashboard, CLI, typed errors, event hooks, config validation, bundle size gate ✅ |

---

## Sprint Tracker

### Sprint 0 — Project Bootstrap (Week 1)
> **Goal:** Repository structure, tooling, CI, all interfaces defined. Zero functionality but the skeleton compiles and tests run.

- [x] **0.1** Initialize monorepo — `pnpm init`, `tsconfig.json` (strict, ESM), `tsup` config producing ESM + CJS. `pnpm build` succeeds.
- [x] **0.2** Configure Vitest — `pnpm test` runs. One placeholder test passes. Coverage configured.
- [x] **0.3** Configure lint + format — ESLint (flat config) + Prettier. `pnpm lint` passes on empty project.
- [x] **0.4** CI pipeline — GitHub Actions: build + test + lint on push/PR. Badge in README.
- [x] **0.5** Define all core types — `src/core/types.ts` with all domain interfaces and types.
- [x] **0.6** Define `JournalStore` interface — `src/stores/interface.ts` with full JSDoc.
- [x] **0.7** Define adapter interfaces — `src/adapters/types.ts` with `AgentExecutor` and `FrameworkAdapter`.
- [x] **0.8** README skeleton — Project name, one-sentence pitch, "coming soon" badge.
- [x] **0.9** `.nvmrc` + `engines` field — Lock Node.js >= 20.

---

### Sprint 1 — Journal Stores (Weeks 2-3)
> **Goal:** Fully functional persistence layer. Both SQLite and Postgres stores pass identical test suites.

- [x] **1.1** Implement `SqliteJournalStore` — `better-sqlite3`, auto-creates tables, all methods.
- [x] **1.2** Implement `PostgresJournalStore` — `pg` driver, migration script, all methods.
- [x] **1.3** Serialization utilities — `serialize()`/`deserialize()` with `superjson`.
- [x] **1.4** `computeOperationKey()` — SHA-256, deterministic, collision-resistant.
- [x] **1.5** Shared test suite — Abstract test class against any `JournalStore`.
- [x] **1.6** SQLite store tests — Shared suite passes. WAL mode for concurrent reads.
- [x] **1.7** Postgres store tests — Shared suite passes. Testcontainers or local Docker.
- [x] **1.8** Cleanup/TTL — `deleteRunsOlderThan()` on both stores.

---

### Sprint 2 — Runtime Core + Recovery (Weeks 4-5)
> **Goal:** A plain-TS agent runs with journaling, crashes mid-execution, and recovers automatically.

- [x] **2.1** `DurableWorkflow` class — `new DurableWorkflow(name, fn, opts)`, `.run(input)` records steps.
- [x] **2.2** `ctx.step()` primitive — Records outcome, returns recorded on recovery.
- [x] **2.3** `ctx.parallel()` primitive — N concurrent steps, partial failure handled.
- [x] **2.4** Heartbeat mechanism — Background interval (10s), cleans up on completion.
- [x] **2.5** `RecoveryEngine` — `detectStaleRuns()` + `recover(runId)`.
- [x] **2.6** Auto-recovery on startup — Scans and recovers stale runs on instantiation.
- [x] **2.7** `IdempotentDispatcher` — `idempotent(key, fn)` checks journal first.
- [x] **2.8** Crash recovery integration test — Kill mid-step, restart, verify no duplicates.
- [x] **2.9** EventBus — Internal emitter for lifecycle events.

---

### Sprint 3 — Framework Adapters (Weeks 6-7)
> **Goal:** Real LangGraph.js and Vercel AI SDK agents work with durable-agents.

- [x] **3.1** LangGraph.js adapter — `createDurableMiddleware(store, config)` as `AgentMiddleware`.
- [x] **3.2** LangGraph.js integration test — createReactAgent with middleware, crash + recover.
- [x] **3.3** AI SDK adapter — `withDurability(store, ctx, fn)` wrapping generateText/streamText.
- [x] **3.4** AI SDK integration test — Records tokens, returns recorded on recovery.
- [x] **3.5** `idempotent()` tool decorator — Works with both frameworks.
- [x] **3.6** Subpath exports — `durable-agents/langgraph` and `durable-agents/ai-sdk` verified.
- [x] **3.7** Peer dependency handling — Package works without adapters installed.

---

### Sprint 4 — Lifecycle Controls (Weeks 8-9)
> **Goal:** Agents are protected: budgets enforced, loops detected, termination works cleanly.

- [x] **4.1** `BudgetController` — Checks cost/time/iterations, returns ok/warning/exceeded.
- [x] **4.2** Budget integration — Before each step, graceful stop on exceeded.
- [x] **4.3** `LoopDetector` — Same-tool, no-progress, and oscillation detection.
- [x] **4.4** Loop integration — After each step, triggers configured action.
- [x] **4.5** Kill switch API — `runtime.terminate(runId, reason)`.
- [x] **4.6** Graceful stop behavior — One final LLM call for summary, then terminate.
- [x] **4.7** Budget test — Workflow with budget, verifies termination at threshold.
- [x] **4.8** Loop test — Intentional loop, verifies detection fires.
- [x] **4.9** Kill switch test — Verifies clean shutdown within 2 seconds.

---

### Sprint 5 — Dashboard + CLI + Polish (Weeks 10-11)
> **Goal:** Usable product with visibility into agent execution.

- [x] **5.1** Dashboard server (Hono) — `startDashboard({ store, port })`.
- [x] **5.2** Runs list page — Table with sorting and filtering.
- [x] **5.3** Run detail page — Step timeline with costs and recovery events.
- [x] **5.4** Live updates — SSE endpoint, htmx real-time.
- [x] **5.5** CLI entry point — `npx durable-agents dashboard` (SQLite/Postgres).
- [x] **5.6** CLI: recover — Scan and recover stale runs.
- [x] **5.7** Error handling polish — Typed errors with clear messages.
- [x] **5.8** Event hooks API — `runtime.on("run:completed", handler)`.
- [x] **5.9** Configuration validation — `RunConfig` validated at construction.
- [x] **5.10** Bundle size check — Core < 50KB minified.

---

### Sprint 6 — Docs + Launch (Week 12)
> **Goal:** Public release. README that sells. Docs that onboard. Demo that convinces.

- [ ] **6.1** README.md — Problem, quickstart, GIF, features, comparison.
- [ ] **6.2** Docs site (or /docs) — Getting Started, Concepts, API Reference, Guides.
- [ ] **6.3** Live demo script — Crash + recover demo, recordable.
- [ ] **6.4** Example: research agent — LangGraph.js + durability.
- [ ] **6.5** Example: AI SDK tool agent — Idempotent tools.
- [ ] **6.6** Publish to npm — Correct exports, types, peer deps.
- [ ] **6.7** GitHub release — v0.1.0 tag + release notes.
- [ ] **6.8** Launch post — Blog/dev.to article.
- [ ] **6.9** Social + community — Discord, Reddit, communities.

---

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-03 | `.kiro/` and `previous-investigation/` gitignored | Internal workspace config and design research, not shipped |
| 2026-08-03 | Repo public from day 1 | Build in public, attract early feedback |
| 2026-08-03 | TypeScript pinned to 5.7.3 | tsup DTS plugin incompatible with TS 7.x at time of bootstrap |
| 2026-08-03 | Code Comments Policy added to constitution | Minimize noise, keep only comments that explain non-obvious behavior |
| 2026-08-03 | GitHub issue/PR templates added | Standardize contributions early; release workflow deferred to Sprint 6 |
| 2026-08-04 | SQLite uses inline DDL, Postgres uses inline constant too | Avoids runtime fs access issues in bundled output |
| 2026-08-04 | Property-based testing with fast-check (13 properties) | Formal correctness verification for serialization, operation keys, and store behavior |
| 2026-08-05 | Sprint 2 complete: runtime core with crash recovery | DurableWorkflow, DurableContext, RecoveryEngine, EventBus, Heartbeat all implemented with 126+ tests |
| 2026-08-08 | Sprint 3 complete: framework adapters | LangGraph.js middleware, AI SDK withDurability wrapper, idempotent tool decorator, 7 correctness properties, subpath export isolation verified |
| 2026-08-10 | Sprint 4 complete: lifecycle controls | BudgetController (pure), LoopDetector (same_tool/no_progress/oscillation), kill switch API, graceful stop state machine, 8 correctness properties, 236+ tests |
| 2026-08-13 | Sprint 5 complete: dashboard, CLI, polish | Hono dashboard with SSE/htmx, CLI (dashboard + recover), DurableError hierarchy, .on()/.off() hooks, config validation, bundle gate 27.77KB, 324 tests across 56 files |

---

## Success Criteria (v0.1)

1. Agent crashes mid-step and resumes correctly in < 2 seconds
2. Idempotent tools never execute twice for the same operation
3. LangGraph.js integration works with real `createReactAgent`
4. Budget enforcement triggers graceful stop
5. Loop detection fires within configured threshold
6. Zero-config start: `npm install durable-agents` + 3 lines = working durability
7. README is compelling (value understood in 30 seconds)
8. CI green: build + tests + lint pass
9. npm publish installs cleanly in fresh project

# Getting Started

Build AI agents that survive crashes. This guide walks you through installing durable-agents, creating your first workflow, and seeing crash recovery in action.

## Prerequisites

- **Node.js ≥ 22** (check with `node --version`)
- **npm** or **pnpm** as your package manager

## Installation

```bash
npm install durable-agents
```

Or with pnpm:

```bash
pnpm add durable-agents
```

## Choose a Store

durable-agents journals every step outcome to a persistent store. Pick one based on your environment:

### SQLite (recommended for development)

Zero config — just provide a file path:

```typescript
import { SqliteJournalStore } from 'durable-agents';

const store = new SqliteJournalStore('./journal.db');
```

SQLite uses WAL mode for performance and creates the schema automatically on first use.

### PostgreSQL (recommended for production)

Pass a standard `pg` pool config:

```typescript
import { PostgresJournalStore } from 'durable-agents';

const store = new PostgresJournalStore({
  connectionString: process.env.DATABASE_URL,
});

await store.migrate(); // creates tables on first run
```

## First Workflow

Create a file called `my-agent.ts`:

```typescript
import { DurableWorkflow, SqliteJournalStore } from 'durable-agents';

const store = new SqliteJournalStore('./journal.db');

const workflow = new DurableWorkflow(
  'research-agent',
  async (ctx, input: { topic: string }) => {
    const sources = await ctx.step('search', async () => {
      // In a real app, this calls an LLM or search API
      return [`source-1-about-${input.topic}`, `source-2-about-${input.topic}`];
    });

    const summary = await ctx.step('summarize', async () => {
      return `Summary of ${sources.length} sources on "${input.topic}"`;
    });

    const report = await ctx.step('compile', async () => {
      return { topic: input.topic, summary, sourceCount: sources.length };
    });

    return report;
  },
  { store },
);

const result = await workflow.run({ topic: 'durable execution' });
console.log('Result:', result);

store.close();
```

Each `ctx.step()` call journals its result. If the process crashes after "search" completes, a recovery run replays the cached result instantly — no duplicate API calls.

## Run It

```bash
npx tsx my-agent.ts
```

Expected output:

```
Result: {
  topic: 'durable execution',
  summary: 'Summary of 2 sources on "durable execution"',
  sourceCount: 2
}
```

A `journal.db` file now holds the outcome of every step.

## Simulate Crash

The library ships with a ready-made demo that shows crash recovery end-to-end:

```bash
npx tsx examples/demo-crash-recovery.ts
```

You'll see output like:

```
Starting 5-step agent workflow...

[STEP 1/5] research — fetched 12 results (42ms)
[STEP 2/5] analyze — extracted 3 key findings (38ms)
[STEP 3/5] draft — generated 450 words (55ms)

[CRASH] Simulated crash! Process killed mid-execution.
───────────────────────────────────────────────────────────

[RESTART] Restarting workflow from journal...

[REPLAY 1/3] research — restored from journal (0ms)
[REPLAY 2/3] analyze — restored from journal (0ms)
[REPLAY 3/3] draft — restored from journal (0ms)
[STEP 4/5] review — checked quality (40ms)
[STEP 5/5] publish — submitted final output (35ms)

[DONE] Workflow completed! 3 steps recovered, 0 LLM calls wasted.
```

Steps 1-3 were replayed from the journal with zero re-execution. Only steps 4-5 ran fresh. No wasted LLM calls, no lost progress.

### How It Works

1. The workflow runs steps 1-3, journaling each outcome to SQLite
2. A crash occurs after step 3 (simulated by throwing an error)
3. The `RecoveryEngine` detects the stale run and re-executes the workflow function
4. Steps 1-3 are **replayed** from the journal — the step function is never called again
5. Steps 4-5 execute normally and complete the workflow

## Next Steps

- [**Core Concepts**](./concepts.md) — understand outcome journaling, operation keys, and recovery semantics
- [**Adapters Guide**](./guides/adapters.md) — integrate with LangGraph.js or Vercel AI SDK
- [**Lifecycle Controls**](./guides/lifecycle-controls.md) — configure budgets, loop detection, and kill switches

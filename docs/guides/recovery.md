# Recovery Guide

Durable-agents provides automatic crash recovery for AI agent workflows. When a process dies mid-execution, the library detects the stale run and replays completed steps from the journal — no LLM calls are re-executed, no money is wasted.

This guide covers how crash detection works, what happens during recovery, and how to configure and trigger it.

---

## Crash Detection

### The Heartbeat Mechanism

Every active run periodically writes a timestamp to the journal store. This is the **heartbeat** — a simple "I'm still alive" signal.

```typescript
const workflow = new DurableWorkflow('my-agent', agentFn, {
  store,
  heartbeatIntervalMs: 10_000,  // write heartbeat every 10s
  staleTimeoutMs: 30_000,       // consider stale after 30s of silence
});
```

The `Heartbeat` class calls `store.updateHeartbeat(runId, generation)` on a fixed interval, where `generation` is the fencing token the worker holds. When the process crashes, the heartbeat stops. The run's last heartbeat timestamp freezes in the database. (If the write is rejected because the generation advanced, the heartbeat also stops and emits `heartbeat:fenced` — see [Concurrency Model](../concepts.md#concurrency-model).)

### When Is a Run "Stale"?

A run is considered stale when:

```
now - lastHeartbeat > staleTimeoutMs
```

The `RecoveryEngine.detectStaleRuns()` method queries the store for all runs whose last heartbeat exceeds the configured timeout. These runs are candidates for recovery.

**Key insight:** The heartbeat interval must always be shorter than the stale timeout. If `heartbeatIntervalMs >= staleTimeoutMs`, the library rejects the config at construction time. A good rule of thumb is `staleTimeoutMs >= 3 × heartbeatIntervalMs` to avoid false positives from GC pauses or I/O spikes.

---

## RecoveryEngine Flow

When recovery is triggered (either automatically or manually), the `RecoveryEngine` follows this sequence:

```mermaid
flowchart TD
    A[detectStaleRuns] --> B[Load steps for run]
    B --> C[Build replayCursor from completed outcomes]
    C --> D[Create DurableContext in replay mode]
    D --> E[Re-invoke workflow function]
    E --> F{Operation key in cursor?}
    F -->|Yes| G[Return cached result — no execution]
    F -->|No| H[Switch to fresh mode — execute function]
    G --> I{More steps?}
    H --> I
    I -->|Yes| F
    I -->|No| J[Mark run as completed]
    J --> K[Emit run:recovered event]
```

### Step-by-step breakdown

1. **detectStaleRuns** — Query the store for runs where `now - lastHeartbeat > staleTimeoutMs`
2. **Load steps** — Fetch all steps belonging to the stale run, ordered by sequence
3. **Build replayCursor** — For each completed step, load its outcome records into a `Map<operationKey, OutcomeRecord>`
4. **Create DurableContext(replay)** — Instantiate a context with `mode: 'replay'` and the populated cursor
5. **Re-invoke fn** — Call the original workflow function with the recovery context and the original input
6. **Replay cached steps** — Each `ctx.step()` call checks the cursor; if a matching operation key exists, the cached result is returned immediately without executing the function
7. **Execute remaining fresh** — Once the cursor is exhausted, subsequent steps execute normally (fresh mode)
8. **Mark completed** — Update the run status to `completed` and increment the `recoveryCount`

---

## Replay Semantics

### What "Replay" Means

During recovery, the workflow function is called again from the beginning. But completed steps are **not re-executed**. Instead, each `ctx.step(name, fn)` call:

1. Computes the operation key: `SHA-256(runId + name + sequence)`
2. Checks if that key exists in the replay cursor
3. If found → returns the cached `result` from the journal (the `fn` is never called)
4. If not found → executes `fn` normally and records the outcome

This means your LLM calls, API requests, and expensive computations from before the crash are never repeated. The journal acts as a deterministic replay log.

### Operation Key Matching

Operation keys are deterministic. They depend on:

- **runId** — unique per execution
- **step name** — the string label you pass to `ctx.step()`
- **sequence number** — auto-incrementing counter within the run

As long as the workflow function calls steps in the same order with the same names, the keys will match. This is why step names and ordering must be stable across recovery.

### The Fresh/Replay Mode Switch

The context starts in `replay` mode. As steps execute:

- **Replay phase**: operation key found in cursor → return cached result, no side effects
- **Fresh phase**: operation key not found → execute the function, record the outcome to the journal

The switch from replay to fresh happens naturally as the cursor is exhausted. There is no explicit mode toggle — the cursor lookup determines the behavior.

---

## Configuration

### heartbeatIntervalMs

How often the heartbeat timestamp is written to the store during execution.

| Property | Value |
|----------|-------|
| Default | `10_000` (10 seconds) |
| Minimum | Must be > 0 |
| Constraint | Must be < `staleTimeoutMs` |

Lower values mean faster crash detection but more database writes.

### staleTimeoutMs

How long a run can go without a heartbeat before being considered stale.

| Property | Value |
|----------|-------|
| Default | `30_000` (30 seconds) |
| Minimum | Must be > `heartbeatIntervalMs` |

Higher values reduce false positives (e.g., during long GC pauses) but increase the delay before crash recovery begins.

### Relationship

```
heartbeatIntervalMs < staleTimeoutMs

Recommended: staleTimeoutMs >= 3 × heartbeatIntervalMs
```

Example configurations:

| Use Case | heartbeatIntervalMs | staleTimeoutMs |
|----------|-------------------|----------------|
| Fast detection (dev) | 2_000 | 10_000 |
| Standard (production) | 10_000 | 30_000 |
| Long-running agents | 30_000 | 120_000 |

---

## Auto-Recovery on Startup

Set `autoRecover: true` in `DurableWorkflowOptions` to automatically scan for and recover stale runs when the workflow is instantiated:

```typescript
const workflow = new DurableWorkflow('research-agent', agentFn, {
  store,
  heartbeatIntervalMs: 10_000,
  staleTimeoutMs: 30_000,
  autoRecover: true,
});
```

### Behavior

When `autoRecover` is enabled, the workflow:

1. Schedules recovery asynchronously (via `queueMicrotask`) — does not block construction
2. Calls `detectStaleRuns()` on the configured store
3. Filters to only runs matching this workflow's name (ignoring stale runs from other workflows)
4. Recovers each matching run sequentially, using the original input stored in the run's metadata
5. Isolates failures — if one run fails to recover, the engine continues with the remaining runs

This is useful for process restarts: when your server comes back up, it automatically picks up where it left off.

### Listening to recovery events

```typescript
workflow.on('run:recovered', (event) => {
  console.log(`Recovered run ${event.runId}`);
  console.log(`  Steps replayed: ${event.totalStepsRecovered}`);
  console.log(`  Resumed from step: ${event.recoveredFromStep}`);
});

workflow.on('run:failed', (event) => {
  console.error(`Recovery failed for ${event.runId}:`, event.error.message);
});
```

---

## Manual Recovery via CLI

For manual intervention, use the CLI to **detect** stale runs. The `recover` command reports stale runs but does not re-execute them — actual recovery happens in a workflow process running with `autoRecover` enabled.

```bash
npx durable-agents recover --db ./agent.db --timeout 30000
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--db <path>` | Path to SQLite database | `./durable-agents.db` |
| `--postgres <url>` | PostgreSQL connection string (use instead of `--db`) | — |
| `--timeout <ms>` | Stale timeout threshold in milliseconds | `30000` |

### Examples

```bash
# Detect stale runs in a SQLite database
npx durable-agents recover --db ./my-agent.db

# Detect with a custom timeout (2 minutes)
npx durable-agents recover --db ./my-agent.db --timeout 120000

# Detect from a PostgreSQL database
npx durable-agents recover --postgres postgresql://localhost:5432/agents
```

### Output

```
Detected 2 stale run(s):
  Stale run: a1b2c3d4 (research-agent)
  Stale run: e5f6g7h8 (summarize-agent)

Summary: 2 stale run(s) detected.
Note: Run your workflow process with autoRecover enabled to perform actual recovery.
```

---

## Edge Cases

### Partial Failures in Parallel Steps

When `ctx.parallel()` is used and a crash occurs mid-execution:

- Steps that completed before the crash have their outcomes in the journal
- During recovery, completed parallel steps are replayed from the cursor
- Incomplete parallel steps are re-executed fresh
- If a parallel step fails during recovery, the entire `parallel()` call throws (same as fresh execution)

The replay cursor handles parallel steps individually — each has its own operation key based on `(runId, stepName, sequence)`.

### Recovery of Terminated Runs

Runs that were explicitly terminated (via `workflow.terminate()` or lifecycle controls like budget/loop detection) are **not** recovered. Only non-terminal runs with a stale heartbeat are candidates.

The `findStaleRuns()` query filters by:
- Status is `running` or `recovering` (not `completed`, `failed`, `stale`, or `terminated`) — a crashed recovery is itself `recovering`, so it stays re-claimable once its heartbeat expires
- Last heartbeat exceeds the stale timeout

### What Happens When Recovery Itself Fails

If the workflow function throws during recovery (after replaying cached steps):

1. The heartbeat is stopped
2. The run status is updated to `failed`
3. A `run:failed` event is emitted with the error and the last completed step sequence
4. The error is re-thrown to the caller

When using `autoRecover`, recovery failures are isolated per-run. The engine catches the error and continues recovering the next stale run. This prevents one poisoned run from blocking recovery of healthy runs.

### Duplicate Recovery Prevention

The heartbeat restarts during recovery, so a live recovery keeps its run fresh and other workers stop treating it as stale. That alone is a timing-based deterrent, not a guarantee — two workers can still claim the same stale run before either refreshes the heartbeat.

The actual guarantee is **generation fencing**. `claimRunForRecovery` advances a monotonic `recovery_generation` token and returns it in the `RecoveryClaim`. Every ownership-sensitive write (`updateHeartbeat`, `createStep`, `recordOutcome`, `updateStep`, `updateRun`, and `terminate()`) must carry the held generation and is applied only while it still matches the persisted value. When two workers race, each claim gets a distinct, strictly increasing generation; only the highest-generation holder can write, and the superseded worker's writes are rejected with `DurableError('FENCED')`. The fenced worker stops its heartbeat, aborts in-flight work, and writes no terminal state (it does not emit `run:failed`) — it yields the run to the winner.

This is single-database fencing for the documented single-store deployment model, **not** distributed leader election. The LangGraph adapter recovery path is deliberately outside the fence: it uses a create-new-run model (marks matching stale runs failed, starts a fresh run) rather than reclaiming a generation.

### Non-Deterministic Workflow Changes

Operation keys are positional: `SHA-256(runId + stepName + sequence)`. If the workflow changes between the original execution and recovery, keys can silently stop matching:

- **Renaming** a step makes that step a cache miss (it re-executes); later steps keep their positions and still replay.
- **Inserting or reordering** steps shifts the sequence of everything after the change, so the whole suffix becomes cache misses and re-executes.
- **Changing a step's implementation while keeping its name and position** does the opposite and more dangerous thing: the stale cached outcome is replayed as-is and the new implementation never runs for that step.

Without a declared version this is accepted-but-silent behavior. To make it explicit and safe, use `workflowVersion` (below).

## Workflow Version Compatibility

`workflowVersion` is an opt-in token you attach to a workflow so recovery can refuse to replay a journal that your current code can no longer honor. It turns the silent re-execution / stale-reuse above into a loud, safe failure.

```typescript
const workflow = new DurableWorkflow('research-agent', agentFn, {
  store,
  workflowVersion: 'research-agent@3',
});
```

The same token is accepted by the LangGraph adapter config (`createDurableMiddleware({ store, config: { name, workflowVersion } })`).

### Compatibility matrix

Recovery compares the token persisted in the run against your current token:

| Persisted (journal) | Current (workflow) | Result |
|---|---|---|
| none | none | **Replay** — legacy positional behavior, unchanged |
| `v` | `v` (equal) | **Replay** |
| `v1` | `v2` (differ) | **Reject** — `DurableError('INCOMPATIBLE_RECOVERY')` |
| none | `v1` | **Reject** |
| `v1` | none | **Reject** |

The two asymmetric rejections are deliberate: once you adopt versions, a journal that cannot prove it is compatible is refused rather than guessed. The check runs **before** any step is replayed, any step is re-executed, or any run state is written, so a rejection:

- replays and re-executes **nothing**;
- leaves the run in its pre-recovery state (`recovering`/stale for the core engine; the stale run is left untouched by the LangGraph adapter), so it remains re-drivable;
- surfaces a `DurableError` whose code is `INCOMPATIBLE_RECOVERY` and whose message names both versions and the run id.

Under `autoRecover`, an incompatible stale run is simply skipped (its claim advances the generation but it is never completed); deploy a workflow carrying the matching version to recover it, or discard the run.

### Adoption and legacy journals

Because the gate is opt-in, existing journals (which carry no version) keep replaying as before **until** you add a `workflowVersion`. The moment you deploy a version, any in-flight runs journaled **before** that deploy fall under "persisted none / current versioned" and are refused by design. Adopt `workflowVersion` when there are no critical runs in flight, or accept that pre-adoption runs will require manual intervention. There is intentionally no legacy opt-out flag — the refusal is the safety property.

### When to bump the version

The runtime does **not** inspect your code or detect semantic changes. Bumping the token is your responsibility. Increment it whenever a change could make a previously-journaled outcome wrong or mis-aligned, including:

- **Step semantics** — a step with the same name now computes a different result, calls a different model/prompt, or hits a different endpoint.
- **Step names** — renaming any `ctx.step` / node label.
- **Ordering** — reordering steps, or inserting/removing a step.
- **Conditional branches** — a change that alters which steps run, or in what order, for the same input.
- **Parallel groups** — adding, removing, renaming, or reordering branches in a `ctx.parallel()` group (branch sequence numbers are positional).

If in doubt, bump it: a false "incompatible" rejection costs you a re-run, while a false "compatible" acceptance can silently serve a wrong cached result.

### What this does not guarantee

`workflowVersion` protects the **journal replay** boundary only. It does not provide exactly-once execution of external side effects: the window between a step's `fn()` returning and its outcome being persisted still exists, and a crash there can re-execute the side effect on recovery regardless of version. Guard non-idempotent side effects with external idempotency keys, as described in [Core Concepts](../concepts.md#crash-window-side-effect-window).

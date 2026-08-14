# Dashboard Guide

The durable-agents dashboard is a lightweight web UI for monitoring workflow runs, inspecting step timelines, and observing events in real time. You can start it programmatically from your application or via the CLI.

## Starting Programmatically

Import `startDashboard` from the `durable-agents/dashboard` subpath:

```typescript
import { startDashboard } from 'durable-agents/dashboard';
import { SqliteJournalStore } from 'durable-agents';
import { EventBus } from 'durable-agents';

const store = new SqliteJournalStore('./agent.db');
const eventBus = new EventBus();

const server = await startDashboard({ store, port: 3100, eventBus });
console.log(`Dashboard at http://localhost:${server.port}`);
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | `JournalStore` | *(required)* | The journal store to read runs and steps from |
| `port` | `number` | `3100` | HTTP port for the dashboard server |
| `eventBus` | `EventBus` | `undefined` | Enables live SSE updates when provided |

### Return Value

`startDashboard` returns a `Promise<DashboardServer>`:

```typescript
interface DashboardServer {
  port: number;
  close(): Promise<void>;
}
```

Call `server.close()` to shut down the HTTP server gracefully.

### Error Handling

If the requested port is already in use, `startDashboard` rejects with a `DurableError`:

```typescript
try {
  const server = await startDashboard({ store, port: 3100 });
} catch (err) {
  if (err.code === 'DASHBOARD_PORT_IN_USE') {
    console.error('Port 3100 is taken, try a different port');
  }
}
```

## Starting via CLI

The dashboard ships as a CLI command — no application code needed:

```bash
npx durable-agents dashboard --port 3100 --db ./agent.db
```

### CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port <number>` | `3100` | HTTP port |
| `--db <path>` | `./durable-agents.db` | SQLite database file |
| `--postgres <url>` | — | Use PostgreSQL instead of SQLite |

Using PostgreSQL:

```bash
npx durable-agents dashboard --postgres postgresql://localhost:5432/agents
```

The CLI connects to the specified store and opens the dashboard. Press `Ctrl+C` to stop.

## Runs List

The root page (`/`) displays all workflow runs in a table:

| Column | Description |
|--------|-------------|
| Run ID | Truncated identifier, links to run detail |
| Workflow | The `name` from `RunConfig` |
| Status | Badge showing `running`, `completed`, `failed`, or `stale` |
| Cost | Total USD cost of the run |
| Steps | Number of completed steps |
| Created | Timestamp when the run started |
| Updated | Timestamp of most recent activity |

### Sorting and Filtering

Append query params to sort and filter the list:

```
http://localhost:3100/?sort=cost&status=running
```

Supported `sort` values: `status`, `cost`, `steps`, `createdAt`, `updatedAt`.

Supported `status` values: any valid run status (`running`, `completed`, `failed`, `stale`).

## Run Detail

Navigate to `/runs/:id` to see the full step timeline for a specific run.

### Run Metadata

At the top of the page you'll see:

- **Run ID** — full identifier
- **Workflow** — configuration name
- **Status** — current run status
- **Total Cost** — accumulated USD cost
- **Total Steps** — number of steps executed
- **Recoveries** — how many times this run was recovered

### Step Timeline

The timeline table shows every step in execution order:

| Column | Description |
|--------|-------------|
| # | Sequence number |
| Step Name | The node/operation name |
| Status | `completed`, `failed`, or `running` |
| Duration | Wall clock time for the step |
| Tokens / Cost | Token count and USD cost |
| Attempt | Execution attempt number |

### Recovery Indicators

Steps with `attempt > 1` display a recovery badge (`↻ recovered`) and are highlighted in the table. This makes it easy to see which steps were replayed from the journal after a crash.

## Live Updates (SSE)

The dashboard uses Server-Sent Events for real-time updates without polling.

### How It Works

The `/events` endpoint streams events from the `EventBus` to connected browser clients. Each event is formatted as a standard SSE message:

```
event: run:started
data: {"type":"run:started","runId":"abc123","timestamp":"..."}

event: step:completed
data: {"type":"step:completed","runId":"abc123","stepId":"s1","timestamp":"..."}

```

### Supported Events

The SSE stream includes all EventBus event types:

- `run:started`, `run:completed`, `run:failed`, `run:recovered`
- `step:started`, `step:completed`
- `budget:warning`, `budget:exceeded`
- `loop:detected`

### htmx Integration

The runs list page uses htmx's SSE extension to auto-update table rows when events arrive:

```html
<div hx-ext="sse" sse-connect="/events" sse-swap="run:started,run:completed,run:failed">
  <!-- table content auto-updates -->
</div>
```

No JavaScript needed on the client beyond the included htmx library. When a run event fires, the table refreshes to reflect the new state.

### Requirement: EventBus

SSE only works if you pass an `eventBus` to `startDashboard`. Without it, the `/events` endpoint returns a `400` response. When using the CLI, an internal EventBus is created automatically.

## CLI Recovery Command

The `recover` command scans for stale runs and reports their status:

```bash
npx durable-agents recover --db ./agent.db
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--db <path>` | `./durable-agents.db` | SQLite database file |
| `--postgres <url>` | — | Use PostgreSQL instead of SQLite |
| `--timeout <ms>` | `30000` | Heartbeat staleness threshold in milliseconds |

### What It Reports

The command detects runs whose heartbeat has exceeded the timeout and reports them:

```
Found 2 stale run(s). Recovering...
  Stale run: a1b2c3d4 (research-workflow)
  Stale run: e5f6g7h8 (summarize-workflow)

Recovery summary: 2 found, 0 failed.
```

If all runs are healthy:

```
All runs are healthy — no stale runs found.
```

Use `--timeout` to control how long a run must be silent before it's considered stale. The default (30 seconds) matches the library's default heartbeat interval.

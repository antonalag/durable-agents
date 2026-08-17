#!/usr/bin/env node

import { SqliteJournalStore } from './stores/sqlite.js';
import { PostgresJournalStore } from './stores/postgres.js';
import { RecoveryEngine } from './runtime/recovery.js';
import { EventBus } from './runtime/event-bus.js';
import { startDashboard } from './dashboard/index.js';
import type { JournalStore } from './stores/interface.js';

export interface ParsedArgs {
  command: 'dashboard' | 'recover' | 'help';
  port: number;
  db: string;
  postgres?: string;
  timeout: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: 'help',
    port: 3100,
    db: './durable-agents.db',
    timeout: 30_000,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--port' && next) {
      args.port = parseInt(next, 10);
      i++;
    } else if (arg === '--db' && next) {
      args.db = next;
      i++;
    } else if (arg === '--postgres' && next) {
      args.postgres = next;
      i++;
    } else if (arg === '--timeout' && next) {
      args.timeout = parseInt(next, 10);
      i++;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    const cmd = positional[0];
    if (cmd === 'dashboard' || cmd === 'recover') {
      args.command = cmd;
    }
  }

  return args;
}

function createStore(args: ParsedArgs): JournalStore {
  if (args.postgres) {
    return new PostgresJournalStore({ connectionString: args.postgres });
  }
  return new SqliteJournalStore(args.db);
}

function printHelp(): void {
  console.log(
    `durable-agents — CLI for the durable execution runtime

Usage:
  durable-agents <command> [options]

Commands:
  dashboard    Start the monitoring dashboard web server
  recover      Detect stale runs (does not re-execute)
  help         Show this help message

Options:
  --port <number>             Dashboard port (default: 3100)
  --db <path>                 SQLite database path (default: ./durable-agents.db)
  --postgres <connection>     Use PostgreSQL instead of SQLite
  --timeout <ms>              Stale timeout for recovery (default: 30000)

Examples:
  durable-agents dashboard --port 8080
  durable-agents recover --db ./my-agent.db
  durable-agents recover --postgres postgresql://localhost:5432/agents`,
  );
}

async function runDashboard(args: ParsedArgs): Promise<void> {
  let store: JournalStore;
  try {
    store = createStore(args);
  } catch (err) {
    console.error(
      `Failed to connect to database: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  try {
    const server = await startDashboard({ store, port: args.port });
    console.log(
      `Dashboard running at http://localhost:${server.port}`,
    );
  } catch (err) {
    console.error(
      `Failed to start dashboard: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}

async function runRecover(args: ParsedArgs): Promise<void> {
  let store: JournalStore;
  try {
    store = createStore(args);
  } catch (err) {
    console.error(
      `Failed to connect to database: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  const eventBus = new EventBus();
  const engine = new RecoveryEngine(store, eventBus, args.timeout);
  const staleRuns = await engine.detectStaleRuns();

  if (staleRuns.length === 0) {
    console.log('All runs are healthy — no stale runs found.');
    return;
  }

  console.log(`Detected ${staleRuns.length} stale run(s):`);

  let detected = 0;

  for (const run of staleRuns) {
    console.log(`  Stale run: ${run.runId} (${run.config.name})`);
    detected++;
  }

  console.log(`\nSummary: ${detected} stale run(s) detected.`);
  console.log('Note: Run your workflow process with autoRecover enabled to perform actual recovery.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'dashboard':
      await runDashboard(args);
      break;
    case 'recover':
      await runRecover(args);
      break;
    case 'help':
    default:
      printHelp();
      break;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

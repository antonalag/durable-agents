// Recording instructions:
//   1. Install asciinema: brew install asciinema (macOS) or pip install asciinema
//   2. Record: asciinema rec demo.cast -c "npx tsx examples/demo-crash-recovery.ts"
//   3. Upload: asciinema upload demo.cast
//   4. Or convert to GIF: agg demo.cast demo.gif

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SqliteJournalStore } from '../src/stores/sqlite.js';
import { DurableWorkflow, type WorkflowFn } from '../src/runtime/workflow.js';
import { RecoveryEngine } from '../src/runtime/recovery.js';
import { EventBus } from '../src/runtime/event-bus.js';

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const STEPS = [
  { name: 'research', desc: 'fetched 12 results' },
  { name: 'analyze', desc: 'extracted 3 key findings' },
  { name: 'draft', desc: 'generated 450 words' },
  { name: 'review', desc: 'checked quality' },
  { name: 'publish', desc: 'submitted final output' },
] as const;

class SimulatedCrash extends Error {
  constructor() {
    super('SIMULATED_CRASH');
    this.name = 'SimulatedCrash';
  }
}

// Tracks which step functions were actually invoked (not replayed from journal)
const invoked = new Set<string>();

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'durable-demo-'));
  const dbPath = join(dir, 'journal.db');
  const store = new SqliteJournalStore(dbPath);
  const eventBus = new EventBus();

  console.log(bold(cyan('\n Starting 5-step agent workflow...\n')));

  // --- First run: crash after step 3 ---
  // We use a "crashing" workflow that throws after 3 successful steps
  let crashTriggered = false;
  const crashingFn: WorkflowFn<null, string[]> = async (ctx, _input) => {
    const results: string[] = [];

    for (let i = 0; i < STEPS.length; i++) {
      const { name, desc } = STEPS[i];

      if (i === 3 && !crashTriggered) {
        crashTriggered = true;
        throw new SimulatedCrash();
      }

      const start = Date.now();
      const result = await ctx.step(name, async () => {
        await sleep(30 + Math.random() * 30);
        return `result:${name}`;
      });

      const elapsed = Date.now() - start;
      console.log(
        `${green(`[STEP ${i + 1}/${STEPS.length}]`)} ${name} — ${desc} ${dim(`(${elapsed}ms)`)}`,
      );

      results.push(result);
    }
    return results;
  };

  const workflow = new DurableWorkflow('research-agent', crashingFn, {
    store,
    eventBus,
    heartbeatIntervalMs: 500,
    staleTimeoutMs: 2000,
  });

  let runId: string | undefined;

  // Listen for run:started to capture the runId
  eventBus.on('run:started', (event) => {
    runId = event.runId;
  });

  try {
    await workflow.run(null);
  } catch (e: unknown) {
    if (e instanceof SimulatedCrash) {
      // Expected — simulate crash output
      console.log(`\n${red('[CRASH]')} Simulated crash! Process killed mid-execution.`);
      console.log(dim('─'.repeat(55)));
    } else {
      throw e;
    }
  }

  if (!runId) {
    throw new Error('Failed to capture runId');
  }

  // Simulate a real crash: set run status back to 'running' as if the process died
  // without cleanup. The DurableWorkflow marks it 'failed', but a real crash leaves it 'running'.
  await store.updateRun(runId, { status: 'running' });

  // --- Recovery phase ---
  console.log(`\n${yellow('[RESTART]')} Restarting workflow from journal...\n`);

  // Small delay to make heartbeat stale
  await sleep(50);

  invoked.clear();

  // Use RecoveryEngine to recover — replayed steps skip the fn, new steps invoke it
  const recoveryBus = new EventBus();
  const recoveryEngine = new RecoveryEngine(store, recoveryBus, 1000);

  const recoveryFn: WorkflowFn<null, string[]> = async (ctx, _input) => {
    const results: string[] = [];

    for (let i = 0; i < STEPS.length; i++) {
      const { name } = STEPS[i];
      const start = Date.now();

      const result = await ctx.step(name, async () => {
        invoked.add(name);
        await sleep(30 + Math.random() * 30);
        return `result:${name}`;
      });

      const elapsed = Date.now() - start;
      results.push(result);

      // Print output after step completes — check if it was replayed or fresh
      if (!invoked.has(name)) {
        // Replayed from journal (fn was never called, so elapsed ~0ms)
        const replayIdx = i + 1;
        console.log(
          `${cyan(`[REPLAY ${replayIdx}/3]`)} ${name} — restored from journal ${dim(`(${elapsed}ms)`)}`,
        );
      } else {
        console.log(
          `${green(`[STEP ${i + 1}/${STEPS.length}]`)} ${name} — ${STEPS[i].desc} ${dim(`(${elapsed}ms)`)}`,
        );
      }
    }

    return results;
  };

  await recoveryEngine.recover(runId, recoveryFn, null);

  // Summary
  const recovered = STEPS.length - invoked.size;
  console.log(
    `\n${bold(green('[DONE]'))} Workflow completed! ${recovered} steps recovered, 0 LLM calls wasted.\n`,
  );

  // Cleanup
  store.close();
  rmSync(dir, { recursive: true });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Demo failed:', err);
    process.exit(1);
  });

import { describe, it, expect, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';

describe('Kill Switch', () => {
  let store: SqliteJournalStore;

  afterEach(() => {
    store?.close();
  });

  it('terminate signals abort on an active run', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    let stepsCompleted = 0;
    let resolveBarrier: () => void;
    const barrier = new Promise<void>((r) => { resolveBarrier = r; });

    const workflow = new DurableWorkflow(
      'kill-test',
      async (ctx) => {
        await ctx.step('first-step', () => {
          stepsCompleted++;
          resolveBarrier!();
          return 'ok';
        });
        // This step should be blocked by terminate
        for (let i = 1; i < 50; i++) {
          await ctx.step(`step-${i}`, () => {
            stepsCompleted++;
            return 'ok';
          });
        }
        return 'done';
      },
      { store, eventBus, heartbeatIntervalMs: 1000, staleTimeoutMs: 5000 },
    );

    const runPromise = workflow.run(null);

    // Wait for first step to complete
    await barrier;
    expect(stepsCompleted).toBe(1);

    const runs = await store.listRuns();
    expect(runs.length).toBe(1);
    const runId = runs[0].runId;

    workflow.terminate(runId, 'manual stop');

    await runPromise;

    // Wait for the fire-and-forget store update
    await new Promise((resolve) => setTimeout(resolve, 50));

    const updatedRun = await store.getRun(runId);
    expect(updatedRun!.status).toBe('terminated');
  });

  it('terminate throws for inactive runId', () => {
    store = new SqliteJournalStore(':memory:');
    const workflow = new DurableWorkflow('kill-test', async () => 'done', {
      store,
      heartbeatIntervalMs: 1000,
      staleTimeoutMs: 5000,
    });

    expect(() => workflow.terminate('nonexistent-run', 'test')).toThrow(
      'Run nonexistent-run is not active',
    );
  });

  it('terminate throws for already-terminated run', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    let resolveBarrier: () => void;
    const barrier = new Promise<void>((r) => { resolveBarrier = r; });

    const workflow = new DurableWorkflow(
      'kill-test',
      async (ctx) => {
        await ctx.step('first', () => {
          resolveBarrier!();
          return 'ok';
        });
        for (let i = 1; i < 50; i++) {
          await ctx.step(`step-${i}`, () => 'ok');
        }
        return 'done';
      },
      { store, eventBus, heartbeatIntervalMs: 1000, staleTimeoutMs: 5000 },
    );

    const runPromise = workflow.run(null);
    await barrier;

    const runs = await store.listRuns();
    const runId = runs[0].runId;

    workflow.terminate(runId, 'first');
    await runPromise;

    expect(() => workflow.terminate(runId, 'second')).toThrow(
      `Run ${runId} is not active`,
    );
  });

  it('terminate records reason in store metadata', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    let resolveBarrier: () => void;
    const barrier = new Promise<void>((r) => { resolveBarrier = r; });

    const workflow = new DurableWorkflow(
      'kill-test',
      async (ctx) => {
        await ctx.step('first', () => {
          resolveBarrier!();
          return 'ok';
        });
        for (let i = 1; i < 50; i++) {
          await ctx.step(`step-${i}`, () => 'ok');
        }
        return 'done';
      },
      { store, eventBus, heartbeatIntervalMs: 1000, staleTimeoutMs: 5000 },
    );

    const runPromise = workflow.run(null);
    await barrier;

    const runs = await store.listRuns();
    workflow.terminate(runs[0].runId, 'user requested stop');
    await runPromise;

    // Wait for the fire-and-forget store update
    await new Promise((resolve) => setTimeout(resolve, 50));

    const updatedRun = await store.getRun(runs[0].runId);
    expect(updatedRun!.metadata.terminationReason).toBe('kill_switch');
    expect(updatedRun!.metadata.terminationDetail).toBe('user requested stop');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';

describe('Graceful Stop', () => {
  let store: SqliteJournalStore;

  afterEach(() => {
    store?.close();
  });

  it('allows exactly one summary step after budget exceeded', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    const stepsExecuted: string[] = [];

    const workflow = new DurableWorkflow(
      'graceful-test',
      async (ctx) => {
        await ctx.step('step-1', () => {
          stepsExecuted.push('step-1');
          return 'a';
        });
        await ctx.step('step-2-summary', () => {
          stepsExecuted.push('step-2-summary');
          return 'summary';
        });
        await ctx.step('step-3', () => {
          stepsExecuted.push('step-3');
          return 'c';
        });
        return 'done';
      },
      {
        store,
        eventBus,
        heartbeatIntervalMs: 1000,
        staleTimeoutMs: 5000,
        budget: { maxSteps: 1 },
      },
    );

    await workflow.run(null);

    expect(stepsExecuted).toContain('step-1');
    expect(stepsExecuted).toContain('step-2-summary');
    expect(stepsExecuted).not.toContain('step-3');
  });

  it('summary step failure records error and terminates', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();

    const workflow = new DurableWorkflow(
      'graceful-fail',
      async (ctx) => {
        await ctx.step('step-1', () => 'ok');
        await ctx.step('summary-fail', () => {
          throw new Error('summary failed');
        });
        return 'done';
      },
      {
        store,
        eventBus,
        heartbeatIntervalMs: 1000,
        staleTimeoutMs: 5000,
        budget: { maxSteps: 1 },
      },
    );

    await workflow.run(null);

    const runs = await store.listRuns();
    const run = await store.getRun(runs[0].runId);
    expect(run!.status).toBe('terminated');
  });

  it('summary step timeout force-terminates', async () => {
    const { withTimeout } = await import('../../src/runtime/workflow.js');

    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve('done'), 5_000);
    });

    await expect(withTimeout(slowPromise, 50)).rejects.toThrow('Summary step timeout');
  });

  it('kill switch skips summary step and terminates immediately', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    const stepsExecuted: string[] = [];

    const workflow = new DurableWorkflow(
      'kill-skip',
      async (ctx) => {
        await ctx.step('step-1', () => {
          stepsExecuted.push('step-1');
          return 'a';
        });
        // Budget triggers graceful stop, but kill switch overrides
        await ctx.step('summary-candidate', () => {
          stepsExecuted.push('summary-candidate');
          return 'summary';
        });
        await ctx.step('post-summary', () => {
          stepsExecuted.push('post-summary');
          return 'c';
        });
        return 'done';
      },
      {
        store,
        eventBus,
        heartbeatIntervalMs: 1000,
        staleTimeoutMs: 5000,
        budget: { maxSteps: 1 },
      },
    );

    // Get lifecycle state reference via events to call terminate mid-run
    let runIdCapture = '';

    eventBus.on('budget:exceeded', (event) => {
      runIdCapture = event.runId;
      // Override the graceful stop with kill switch
      workflow.terminate(event.runId, 'kill override');
    });

    await workflow.run(null);

    // Wait for fire-and-forget store update
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Kill switch terminates immediately — no summary step should run
    expect(stepsExecuted).toEqual(['step-1']);

    const updatedRun = await store.getRun(runIdCapture);
    expect(updatedRun!.status).toBe('terminated');
    expect(updatedRun!.metadata.terminationReason).toBe('kill_switch');
  });

  it('records termination reason budget_exceeded in metadata', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();

    const workflow = new DurableWorkflow(
      'reason-test',
      async (ctx) => {
        await ctx.step('step-1', () => 'ok');
        await ctx.step('summary', () => 'partial result');
        await ctx.step('blocked', () => 'should not run');
        return 'done';
      },
      {
        store,
        eventBus,
        heartbeatIntervalMs: 1000,
        staleTimeoutMs: 5000,
        budget: { maxSteps: 1 },
      },
    );

    await workflow.run(null);

    // Wait for any async store updates
    await new Promise((resolve) => setTimeout(resolve, 50));

    const runs = await store.listRuns();
    const run = await store.getRun(runs[0].runId);
    expect(run!.status).toBe('terminated');
    expect(run!.metadata.terminationReason).toBe('budget_exceeded');
  });
});

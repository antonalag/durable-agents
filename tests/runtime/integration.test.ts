import { describe, it, expect, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableWorkflow, type WorkflowFn } from '../../src/runtime/workflow.js';
import { RecoveryEngine } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';

describe('Integration: end-to-end runtime scenarios', () => {
  let store: SqliteJournalStore;

  afterEach(() => {
    store?.close();
  });

  it('abort mid-step then recover produces no duplicate side effects', async () => {
    store = new SqliteJournalStore(':memory:');
    let callCount = 0;

    const workflowFn: WorkflowFn<null, string> = async (ctx) => {
      await ctx.step('step-0', () => {
        callCount++;
        return 'first';
      });
      await ctx.step('step-1', () => {
        callCount++;
        return 'second';
      });
      return 'done';
    };

    // First run: abort after step-0 completes but before step-1 finishes
    const controller = new AbortController();

    const workflow = new DurableWorkflow<null, string>(
      'abort-test',
      async (ctx) => {
        await ctx.step('step-0', () => {
          callCount++;
          return 'first';
        });
        // Abort before step-1 executes
        controller.abort();
        await ctx.step('step-1', () => {
          callCount++;
          return 'second';
        });
        return 'done';
      },
      { store, eventBus: new EventBus(), heartbeatIntervalMs: 1000, staleTimeoutMs: 30000 },
    );

    // Run with abort signal — the abort happens between step-0 and step-1
    await workflow.run(null, { signal: controller.signal });

    // step-0 executed (callCount=1), step-1 was blocked by abort
    const firstCallCount = callCount;
    expect(firstCallCount).toBe(1);

    // The run was left as 'running' (abort path) — but createRun sets 'pending'.
    // Let's find runs that are NOT completed to recover them.
    // Actually, looking at workflow.ts: abort returns undefined without updating status,
    // so the run status stays at 'pending' as created. Let's update it to 'running'
    // to simulate a real mid-execution crash scenario.
    const allRuns = await store.listRuns();
    expect(allRuns.length).toBe(1);

    // Manually mark as running to simulate stale state
    await store.updateRun(allRuns[0].runId, { status: 'running' });

    // Recover the stale run
    const eventBus = new EventBus();
    const engine = new RecoveryEngine(store, eventBus, 30_000);
    callCount = 0; // reset counter

    await engine.recover(allRuns[0].runId, workflowFn, null);

    // step-0 should replay from journal (no fn call), step-1 should execute fresh
    expect(callCount).toBe(1);

    // Run should now be completed
    const recoveredRun = await store.getRun(allRuns[0].runId);
    expect(recoveredRun!.status).toBe('completed');
  });

  it('parallel partial failure persists successful outcomes', async () => {
    store = new SqliteJournalStore(':memory:');

    const workflow = new DurableWorkflow<null, string>(
      'parallel-test',
      async (ctx) => {
        try {
          await ctx.parallel([
            { name: 'ok-step', fn: () => 'success' },
            { name: 'fail-step', fn: () => { throw new Error('boom'); } },
            { name: 'ok-step-2', fn: () => 'also-success' },
          ]);
        } catch {
          // Swallow — we want to verify what was persisted
        }
        return 'partial';
      },
      { store, eventBus: new EventBus(), heartbeatIntervalMs: 1000, staleTimeoutMs: 30000 },
    );

    const result = await workflow.run(null);
    expect(result).toBe('partial');

    // Check that successful outcomes were persisted
    const runs = await store.listRuns();
    expect(runs.length).toBe(1);

    const steps = await store.listSteps(runs[0].runId);

    // All 3 steps were created (ok-step, fail-step, ok-step-2)
    // At least the successful ones should be completed
    const completedSteps = steps.filter((s) => s.status === 'completed');
    expect(completedSteps.length).toBeGreaterThanOrEqual(1);

    // Verify we can find an outcome for a successful step
    const okStep = steps.find((s) => s.nodeName === 'ok-step' && s.status === 'completed');
    expect(okStep).toBeDefined();

    if (okStep) {
      const outcomes = await store.listOutcomes(okStep.stepId);
      expect(outcomes.length).toBe(1);
      expect(outcomes[0].result).toBe('success');
    }
  });

  it('auto-recovery recovers stale runs on workflow instantiation', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();

    // Create a "stale" run manually — mark it as running
    const staleRun = await store.createRun({
      name: 'auto-recover-workflow',
      heartbeatIntervalMs: 10_000,
      staleTimeoutMs: 30_000,
      metadata: { input: null },
    });

    // Mark the run as 'running' so findStaleRuns can pick it up
    await store.updateRun(staleRun.runId, { status: 'running' });

    // Wait a bit so the heartbeat ages past our short staleTimeoutMs
    await new Promise((resolve) => setTimeout(resolve, 20));

    const recoveredEvents: Array<{ runId: string }> = [];
    eventBus.on('run:recovered', (e) => recoveredEvents.push(e));

    const workflowFn: WorkflowFn<null, string> = async (ctx) => {
      await ctx.step('auto-step', () => 'recovered');
      return 'done';
    };

    // Instantiate with autoRecover and a very short staleTimeout
    new DurableWorkflow<null, string>('auto-recover-workflow', workflowFn, {
      store,
      eventBus,
      autoRecover: true,
      staleTimeoutMs: 10, // very short so our run is immediately stale
      heartbeatIntervalMs: 2,
    });

    // Wait for the async recovery to complete (queueMicrotask + async work)
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(recoveredEvents.length).toBe(1);
    expect(recoveredEvents[0].runId).toBe(staleRun.runId);

    // Verify the run is now completed
    const recovered = await store.getRun(staleRun.runId);
    expect(recovered!.status).toBe('completed');
  });

  it('emits events in correct order for a full workflow run', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    const events: string[] = [];

    eventBus.on('run:started', () => events.push('run:started'));
    eventBus.on('step:started', () => events.push('step:started'));
    eventBus.on('step:completed', () => events.push('step:completed'));
    eventBus.on('run:completed', () => events.push('run:completed'));

    const workflow = new DurableWorkflow<null, string>(
      'event-test',
      async (ctx) => {
        await ctx.step('s1', () => 'one');
        await ctx.step('s2', () => 'two');
        return 'final';
      },
      { store, eventBus, heartbeatIntervalMs: 1000, staleTimeoutMs: 30000 },
    );

    await workflow.run(null);

    expect(events).toEqual([
      'run:started',
      'step:started',
      'step:completed',
      'step:started',
      'step:completed',
      'run:completed',
    ]);
  });
});

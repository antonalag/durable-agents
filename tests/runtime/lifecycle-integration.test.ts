import { describe, it, expect, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import type {
  BudgetWarningEvent,
  BudgetExceededEvent,
  LoopDetectedEvent,
} from '../../src/core/types.js';

describe('Lifecycle Integration', () => {
  let store: SqliteJournalStore;

  afterEach(() => {
    store?.close();
  });

  it('budget exceeded triggers graceful stop with summary step', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    const stepsExecuted: string[] = [];
    const exceededEvents: BudgetExceededEvent[] = [];
    eventBus.on('budget:exceeded', (e) => exceededEvents.push(e));

    const workflow = new DurableWorkflow('budget-integration', async (ctx) => {
      for (let i = 0; i < 10; i++) {
        await ctx.step(`step-${i}`, () => { stepsExecuted.push(`step-${i}`); return i; });
      }
      return 'done';
    }, {
      store, eventBus,
      heartbeatIntervalMs: 1000, staleTimeoutMs: 5000,
      budget: { maxSteps: 3 },
    });

    await workflow.run(null);

    // Steps 0-2 execute normally (totals.steps is 0,1,2 before each)
    // Before step-3: totals.steps=3 >= maxSteps=3 → exceeded
    // Step-3 is the summary step (allowed)
    // Step-4+ blocked
    expect(stepsExecuted.length).toBe(4); // 3 normal + 1 summary
    expect(exceededEvents.length).toBeGreaterThanOrEqual(1);
    expect(exceededEvents[0].action).toBe('graceful_stop');

    const runs = await store.listRuns();
    const run = await store.getRun(runs[0].runId);
    expect(run!.status).toBe('terminated');
    expect(run!.metadata.terminationReason).toBe('budget_exceeded');
  });

  it('loop detection with graceful_stop terminates after summary', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    const stepsExecuted: string[] = [];
    const loopEvents: LoopDetectedEvent[] = [];
    eventBus.on('loop:detected', (e) => loopEvents.push(e));

    const workflow = new DurableWorkflow('loop-graceful', async (ctx) => {
      for (let i = 0; i < 10; i++) {
        await ctx.step('repeated-tool', () => { stepsExecuted.push('repeated-tool'); return 'same'; });
      }
      return 'done';
    }, {
      store, eventBus,
      heartbeatIntervalMs: 1000, staleTimeoutMs: 5000,
      loopDetection: { maxRepetitions: 3, action: 'graceful_stop' },
    });

    await workflow.run(null);

    // After step 4 (4 consecutive same tool > maxRep=3), loop detected
    // Next step is the summary step, then terminated
    expect(loopEvents.length).toBeGreaterThanOrEqual(1);
    expect(loopEvents[0].loopType).toBe('same_tool');
    expect(stepsExecuted.length).toBeLessThan(10);

    const runs = await store.listRuns();
    const run = await store.getRun(runs[0].runId);
    expect(run!.status).toBe('terminated');
    expect(run!.metadata.terminationReason).toBe('loop_detected');
  });

  it('loop detection with emit_only continues execution', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    const loopEvents: LoopDetectedEvent[] = [];
    eventBus.on('loop:detected', (e) => loopEvents.push(e));
    let stepsRun = 0;

    const workflow = new DurableWorkflow('loop-emit', async (ctx) => {
      for (let i = 0; i < 8; i++) {
        await ctx.step('repeated-tool', () => { stepsRun++; return 'same'; });
      }
      return 'done';
    }, {
      store, eventBus,
      heartbeatIntervalMs: 1000, staleTimeoutMs: 5000,
      loopDetection: { maxRepetitions: 3, action: 'emit_only' },
    });

    const result = await workflow.run(null);

    // All 8 steps run (emit_only doesn't stop execution)
    expect(stepsRun).toBe(8);
    expect(result).toBe('done');
    // Loop was detected but execution continued
    expect(loopEvents.length).toBeGreaterThanOrEqual(1);
    expect(loopEvents[0].loopType).toBe('same_tool');

    const runs = await store.listRuns();
    const run = await store.getRun(runs[0].runId);
    expect(run!.status).toBe('completed');
  });

  it('kill switch immediately terminates without summary step', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    let stepsRun = 0;
    let resolveBarrier: () => void;
    const barrier = new Promise<void>((r) => { resolveBarrier = r; });

    const workflow = new DurableWorkflow('kill-integration', async (ctx) => {
      await ctx.step('step-0', () => { stepsRun++; resolveBarrier!(); return 'a'; });
      for (let i = 1; i < 50; i++) {
        await ctx.step(`step-${i}`, () => { stepsRun++; return 'x'; });
      }
      return 'done';
    }, {
      store, eventBus,
      heartbeatIntervalMs: 1000, staleTimeoutMs: 5000,
    });

    const runPromise = workflow.run(null);
    await barrier;

    const runs = await store.listRuns();
    workflow.terminate(runs[0].runId, 'external kill');
    await runPromise;
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(stepsRun).toBe(1);
    const updatedRun = await store.getRun(runs[0].runId);
    expect(updatedRun!.status).toBe('terminated');
    expect(updatedRun!.metadata.terminationReason).toBe('kill_switch');
  });

  it('workflow with no lifecycle config has zero overhead (all steps execute)', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    let stepsRun = 0;

    const workflow = new DurableWorkflow('no-config', async (ctx) => {
      for (let i = 0; i < 10; i++) {
        await ctx.step(`step-${i}`, () => { stepsRun++; return i; });
      }
      return 'done';
    }, {
      store, eventBus,
      heartbeatIntervalMs: 1000, staleTimeoutMs: 5000,
    });

    const result = await workflow.run(null);

    expect(stepsRun).toBe(10);
    expect(result).toBe('done');

    const runs = await store.listRuns();
    const run = await store.getRun(runs[0].runId);
    expect(run!.status).toBe('completed');
  });

  it('budget + loop detection together: budget fires first', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    const exceededEvents: BudgetExceededEvent[] = [];
    const loopEvents: LoopDetectedEvent[] = [];
    eventBus.on('budget:exceeded', (e) => exceededEvents.push(e));
    eventBus.on('loop:detected', (e) => loopEvents.push(e));

    const workflow = new DurableWorkflow('both-controls', async (ctx) => {
      for (let i = 0; i < 20; i++) {
        await ctx.step('same-tool', () => 'same');
      }
      return 'done';
    }, {
      store, eventBus,
      heartbeatIntervalMs: 1000, staleTimeoutMs: 5000,
      budget: { maxSteps: 2 },
      loopDetection: { maxRepetitions: 3, action: 'graceful_stop' },
    });

    await workflow.run(null);

    // Budget exceeded after 2 steps (before loop would fire at 4)
    expect(exceededEvents.length).toBeGreaterThanOrEqual(1);

    const runs = await store.listRuns();
    const run = await store.getRun(runs[0].runId);
    expect(run!.status).toBe('terminated');
  });

  it('budget:warning event contains correct fields', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    const warnings: BudgetWarningEvent[] = [];
    eventBus.on('budget:warning', (e) => warnings.push(e));

    const workflow = new DurableWorkflow('warning-fields', async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await ctx.step(`step-${i}`, () => i);
      }
      return 'done';
    }, {
      store, eventBus,
      heartbeatIntervalMs: 1000, staleTimeoutMs: 5000,
      budget: { maxSteps: 10, warningThreshold: 0.3 },
    });

    await workflow.run(null);

    // At step 3 or 4: totals.steps/maxSteps >= 0.3 → warning fires
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const w = warnings[0];
    expect(w.type).toBe('budget:warning');
    expect(w.runId).toBeDefined();
    expect(typeof w.percentUsed).toBe('number');
    expect(w.percentUsed).toBeGreaterThanOrEqual(0.3);
  });

  it('loop:detected event contains correct fields', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    const loopEvents: LoopDetectedEvent[] = [];
    eventBus.on('loop:detected', (e) => loopEvents.push(e));

    const workflow = new DurableWorkflow('loop-fields', async (ctx) => {
      for (let i = 0; i < 10; i++) {
        await ctx.step('same-tool', () => 'result');
      }
      return 'done';
    }, {
      store, eventBus,
      heartbeatIntervalMs: 1000, staleTimeoutMs: 5000,
      loopDetection: { maxRepetitions: 3, action: 'emit_only' },
    });

    await workflow.run(null);

    expect(loopEvents.length).toBeGreaterThanOrEqual(1);
    const e = loopEvents[0];
    expect(e.type).toBe('loop:detected');
    expect(e.runId).toBeDefined();
    expect(e.loopType).toBe('same_tool');
    expect(typeof e.detectedAtStep).toBe('number');
    expect(typeof e.repetitions).toBe('number');
    expect(e.repetitions).toBeGreaterThan(3);
  });
});

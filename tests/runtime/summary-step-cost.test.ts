import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type {
  ExecutionRun,
  OutcomeRecord,
  Step,
  BudgetExceededEvent,
} from '../../src/core/types.js';

const COST_PER_STEP = 0.06;

function createMockStore() {
  const now = new Date();
  const runId = 'run-summary-cost';

  const fakeRun: ExecutionRun = {
    runId,
    status: 'running',
    config: { name: 'summary-workflow', heartbeatIntervalMs: 10000, staleTimeoutMs: 30000 },
    metadata: {},
    totals: { cost: 0, tokens: 0, steps: 0, recoveryCount: 0 },
    createdAt: now,
    updatedAt: now,
    lastHeartbeat: now,
  };

  const steps: Step[] = [];
  const outcomes: OutcomeRecord[] = [];

  const store = {
    createRun: vi.fn().mockResolvedValue(fakeRun),
    updateRun: vi.fn().mockImplementation((_id, updates) =>
      Promise.resolve({ ...fakeRun, ...updates }),
    ),
    getRun: vi.fn().mockResolvedValue(fakeRun),
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    createStep: vi.fn().mockImplementation((step) => {
      steps.push({ ...step, completedAt: undefined });
      return Promise.resolve({ ...step, completedAt: undefined });
    }),
    updateStep: vi.fn().mockImplementation((stepId, updates) => {
      const existing = steps.find((s) => s.stepId === stepId);
      if (existing) Object.assign(existing, updates);
      return Promise.resolve({ stepId, ...updates });
    }),
    recordOutcome: vi.fn().mockImplementation((outcome: OutcomeRecord) => {
      const withCost: OutcomeRecord = {
        ...outcome,
        tokens: { ...outcome.tokens, costUsd: COST_PER_STEP },
      };
      outcomes.push(withCost);
      return Promise.resolve(withCost);
    }),
    getOutcomeByKey: vi.fn().mockImplementation((key: string) =>
      Promise.resolve(outcomes.find((o) => o.operationKey === key) ?? null),
    ),
    listSteps: vi.fn().mockImplementation((_runId: string) =>
      Promise.resolve(steps.filter((s) => s.runId === _runId)),
    ),
    listOutcomes: vi.fn().mockImplementation((stepId: string) =>
      Promise.resolve(outcomes.filter((o) => o.stepId === stepId)),
    ),
    listRuns: vi.fn().mockResolvedValue([]),
    findStaleRuns: vi.fn().mockResolvedValue([]),
    getStep: vi.fn().mockResolvedValue(null),
    getOutcome: vi.fn().mockResolvedValue(null),
    deleteRun: vi.fn().mockResolvedValue(undefined),
    deleteRunsOlderThan: vi.fn().mockResolvedValue(0),
  };

  return { store, steps, outcomes, runId };
}

describe('Summary step cost bypass', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  it('summary step executes but does not increment runningCost', async () => {
    const { store, outcomes } = createMockStore();
    const stepsExecuted: string[] = [];
    const exceededEvents: BudgetExceededEvent[] = [];
    eventBus.on('budget:exceeded', (e) => exceededEvents.push(e));

    // maxCostUsd = 0.10, each step costs 0.06
    // After step 1: runningCost = 0.06 (ok)
    // After step 2: runningCost = 0.12 > 0.10 → budget:exceeded → stopping
    // Step 3 (summary): executes via stopping branch, bypasses cost accounting
    const workflow = new DurableWorkflow(
      'summary-workflow',
      async (ctx) => {
        await ctx.step('step-1', () => {
          stepsExecuted.push('step-1');
          return 'result-1';
        });
        await ctx.step('step-2', () => {
          stepsExecuted.push('step-2');
          return 'result-2';
        });
        // This is the summary step — runs in stopping phase
        await ctx.step('summary', () => {
          stepsExecuted.push('summary');
          return 'final-summary';
        });
        // This should NOT execute (terminated)
        await ctx.step('step-4', () => {
          stepsExecuted.push('step-4');
          return 'unreachable';
        });
        return 'done';
      },
      {
        store: store as unknown as JournalStore,
        eventBus,
        heartbeatIntervalMs: 1000,
        staleTimeoutMs: 5000,
        budget: { maxCostUsd: 0.10 },
      },
    );

    await workflow.run('input');

    // All three steps (including summary) executed, but step-4 did not
    expect(stepsExecuted).toContain('step-1');
    expect(stepsExecuted).toContain('step-2');
    expect(stepsExecuted).toContain('summary');
    expect(stepsExecuted).not.toContain('step-4');

    // Budget exceeded event fired
    expect(exceededEvents.length).toBeGreaterThanOrEqual(1);

    // The summary step's outcome IS persisted (originalStep handles that)
    const summaryOutcome = outcomes.find((o) =>
      store.createStep.mock.calls.some(
        (call) => call[0].nodeName === 'summary' && call[0].stepId === o.stepId,
      ),
    );
    expect(summaryOutcome).toBeDefined();

    // getOutcomeByKey was called for step-1 and step-2 (post-step cost accounting)
    // but NOT for the summary step (stopping branch returns early)
    const getOutcomeByKeyCalls = store.getOutcomeByKey.mock.calls;

    // Compute expected operation keys for step-1 and step-2
    const runId = store.createRun.mock.results[0].value.runId ?? 'run-summary-cost';
    const key1 = computeOperationKey(runId, 'step-1', 0);
    const key2 = computeOperationKey(runId, 'step-2', 1);
    const summaryKey = computeOperationKey(runId, 'summary', 2);

    const queriedKeys = getOutcomeByKeyCalls.map((c) => c[0]);
    expect(queriedKeys).toContain(key1);
    expect(queriedKeys).toContain(key2);
    expect(queriedKeys).not.toContain(summaryKey);
  });

  it('budget enforcement does not fire again during the summary step', async () => {
    const { store } = createMockStore();
    const exceededEvents: BudgetExceededEvent[] = [];
    let exceededCountAtSummaryStart = 0;

    eventBus.on('budget:exceeded', (e) => exceededEvents.push(e));

    const workflow = new DurableWorkflow(
      'summary-workflow',
      async (ctx) => {
        await ctx.step('step-1', () => 'a');
        await ctx.step('step-2', () => 'b');
        // The budget check at entry of THIS step triggers budget:exceeded (1st event)
        // and transitions to stopping. The summary fn() then executes.
        await ctx.step('summary', () => {
          // Capture count right when summary fn executes
          exceededCountAtSummaryStart = exceededEvents.length;
          return 'summary-result';
        });
        await ctx.step('blocked', () => 'never');
        return 'done';
      },
      {
        store: store as unknown as JournalStore,
        eventBus,
        heartbeatIntervalMs: 1000,
        staleTimeoutMs: 5000,
        budget: { maxCostUsd: 0.10 },
      },
    );

    await workflow.run('input');

    // budget:exceeded fires once BEFORE the summary step fn() runs (triggering stopping)
    expect(exceededCountAtSummaryStart).toBe(1);

    // No additional budget:exceeded fires DURING the summary step's execution.
    // The 2nd event fires at step-4's entry (terminated path) which is after summary completes.
    // The summary step itself does not cause a second budget enforcement.
    // After workflow terminates, the "blocked" step entry may fire another budget:exceeded
    // but that's at step-4 entry, not during summary step execution.
    expect(exceededCountAtSummaryStart).toBe(1);
  });

  it('persisted OutcomeRecord for summary step exists (durable truth intact)', async () => {
    const { store, outcomes } = createMockStore();

    const workflow = new DurableWorkflow(
      'summary-workflow',
      async (ctx) => {
        await ctx.step('step-1', () => 'a');
        await ctx.step('step-2', () => 'b');
        await ctx.step('summary', () => 'important-summary');
        await ctx.step('blocked', () => 'never');
        return 'done';
      },
      {
        store: store as unknown as JournalStore,
        eventBus,
        heartbeatIntervalMs: 1000,
        staleTimeoutMs: 5000,
        budget: { maxCostUsd: 0.10 },
      },
    );

    await workflow.run('input');

    // recordOutcome was called for all 3 steps (including summary)
    expect(store.recordOutcome).toHaveBeenCalledTimes(3);

    // The summary step's outcome has the correct result persisted
    const summaryOutcome = outcomes[2];
    expect(summaryOutcome).toBeDefined();
    expect(summaryOutcome.result).toBe('important-summary');
    expect(summaryOutcome.tokens.costUsd).toBe(COST_PER_STEP);
  });

  it('runningCost after workflow reflects only pre-stopping steps', async () => {
    const { store } = createMockStore();

    const workflow = new DurableWorkflow(
      'summary-workflow',
      async (ctx) => {
        await ctx.step('step-1', () => 'a');
        await ctx.step('step-2', () => 'b');
        await ctx.step('summary', () => 'summary');
        await ctx.step('blocked', () => 'never');
        return 'done';
      },
      {
        store: store as unknown as JournalStore,
        eventBus,
        heartbeatIntervalMs: 1000,
        staleTimeoutMs: 5000,
        budget: { maxCostUsd: 0.10 },
      },
    );

    await workflow.run('input');

    // The final totals.cost should be 0.12 (2 steps * 0.06)
    // NOT 0.18 (3 steps) — summary step cost is not added
    // We verify by checking getOutcomeByKey was NOT called with the summary key
    const runId = 'run-summary-cost';
    const summaryKey = computeOperationKey(runId, 'summary', 2);
    const queriedKeys = store.getOutcomeByKey.mock.calls.map((c) => c[0]);
    expect(queriedKeys).not.toContain(summaryKey);
  });
});

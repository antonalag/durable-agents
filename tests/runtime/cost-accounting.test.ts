import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { RecoveryEngine } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type {
  ExecutionRun,
  OutcomeRecord,
  Step,
  BudgetExceededEvent,
} from '../../src/core/types.js';
import type { DurableContextImpl } from '../../src/runtime/context.js';

const COST_PER_STEP = 0.10;

function createCostTrackingStore(opts?: { existingCostSteps?: number }) {
  const now = new Date();
  const runId = 'run-cost-1';
  const existingSteps = opts?.existingCostSteps ?? 0;

  const fakeRun: ExecutionRun = {
    runId,
    status: 'running',
    config: { name: 'cost-workflow', heartbeatIntervalMs: 10000, staleTimeoutMs: 30000 },
    metadata: {},
    totals: { cost: existingSteps * COST_PER_STEP, tokens: 0, steps: existingSteps, recoveryCount: 0 },
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
      // Inject non-zero cost to simulate what an adapter would do
      const withCost: OutcomeRecord = {
        ...outcome,
        tokens: { ...outcome.tokens, costUsd: COST_PER_STEP },
      };
      outcomes.push(withCost);
      return Promise.resolve(withCost);
    }),
    getOutcomeByKey: vi.fn().mockResolvedValue(null),
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

describe('maxCostUsd cost accounting', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  it('multiple fresh steps accumulate costUsd into run.totals.cost', async () => {
    const { store } = createCostTrackingStore();

    const workflow = new DurableWorkflow(
      'cost-workflow',
      async (ctx) => {
        await ctx.step('step-a', () => 'a');
        await ctx.step('step-b', () => 'b');
        await ctx.step('step-c', () => 'c');
        return 'done';
      },
      { store: store as unknown as JournalStore, eventBus },
    );

    await workflow.run('input');

    // The final updateRun(completed) should include accumulated cost
    const completedCall = store.updateRun.mock.calls.find(
      (call) => call[1]?.status === 'completed',
    );
    expect(completedCall).toBeDefined();
    expect(completedCall![1].totals.cost).toBeCloseTo(0.30);
  });

  it('replayed steps during recovery do NOT add to cost', async () => {
    const now = new Date();
    const runId = 'run-replay-cost';

    // Simulate a run that already completed 2 steps with cost
    const completedSteps: Step[] = [
      {
        stepId: 'step-0',
        runId,
        nodeName: 'step-a',
        sequence: 0,
        status: 'completed',
        startedAt: now,
        completedAt: now,
        cost: { inputTokens: 0, outputTokens: 0, costUsd: COST_PER_STEP },
        attempt: 1,
      },
      {
        stepId: 'step-1',
        runId,
        nodeName: 'step-b',
        sequence: 1,
        status: 'completed',
        startedAt: now,
        completedAt: now,
        cost: { inputTokens: 0, outputTokens: 0, costUsd: COST_PER_STEP },
        attempt: 1,
      },
    ];

    const existingOutcomes: OutcomeRecord[] = completedSteps.map((step, i) => ({
      outcomeId: `outcome-${i}`,
      stepId: step.stepId,
      operationType: 'custom' as const,
      operationKey: computeOperationKey(runId, step.nodeName, step.sequence),
      result: `result-${i}`,
      tokens: { inputTokens: 0, outputTokens: 0, costUsd: COST_PER_STEP },
      durationMs: 10,
      recordedAt: now,
    }));

    const fakeRun: ExecutionRun = {
      runId,
      status: 'running',
      config: { name: 'cost-workflow', heartbeatIntervalMs: 10000, staleTimeoutMs: 30000 },
      metadata: {},
      totals: { cost: 0.20, tokens: 0, steps: 2, recoveryCount: 0 },
      createdAt: now,
      updatedAt: now,
      lastHeartbeat: now,
    };

    const store = {
      getRun: vi.fn().mockResolvedValue(fakeRun),
      listSteps: vi.fn().mockResolvedValue(completedSteps),
      listOutcomes: vi.fn().mockImplementation((stepId: string) =>
        Promise.resolve(existingOutcomes.filter((o) => o.stepId === stepId)),
      ),
      updateRun: vi.fn().mockResolvedValue({ ...fakeRun, status: 'completed' }),
      updateHeartbeat: vi.fn().mockResolvedValue(undefined),
      createStep: vi.fn().mockImplementation((step) => Promise.resolve({ ...step, completedAt: undefined })),
      updateStep: vi.fn().mockImplementation((stepId, updates) => Promise.resolve({ stepId, ...updates })),
      recordOutcome: vi.fn().mockImplementation((outcome) => Promise.resolve(outcome)),
      getOutcomeByKey: vi.fn().mockResolvedValue(null),
      findStaleRuns: vi.fn().mockResolvedValue([]),
      createRun: vi.fn().mockResolvedValue(fakeRun),
      getStep: vi.fn().mockResolvedValue(null),
      getOutcome: vi.fn().mockResolvedValue(null),
      listRuns: vi.fn().mockResolvedValue([]),
      deleteRun: vi.fn().mockResolvedValue(undefined),
      deleteRunsOlderThan: vi.fn().mockResolvedValue(0),
    };

    const engine = new RecoveryEngine(store as unknown as JournalStore, eventBus, 30000);

    // Workflow replays 2 existing steps — no new outcomes should be created
    const workflowFn = async (ctx: DurableContextImpl) => {
      await ctx.step('step-a', () => 'result-0');
      await ctx.step('step-b', () => 'result-1');
      return 'done';
    };

    await engine.recover(runId, workflowFn, 'input');

    // Replayed steps should NOT have triggered recordOutcome
    expect(store.recordOutcome).not.toHaveBeenCalled();
  });

  it('recovery preserves previously accumulated cost baseline', async () => {
    const now = new Date();
    const runId = 'run-cost-preserve';

    const completedSteps: Step[] = [
      {
        stepId: 'step-0',
        runId,
        nodeName: 'step-a',
        sequence: 0,
        status: 'completed',
        startedAt: now,
        completedAt: now,
        cost: { inputTokens: 0, outputTokens: 0, costUsd: COST_PER_STEP },
        attempt: 1,
      },
    ];

    const existingOutcomes: OutcomeRecord[] = [{
      outcomeId: 'outcome-0',
      stepId: 'step-0',
      operationType: 'custom',
      operationKey: computeOperationKey(runId, 'step-a', 0),
      result: 'result-0',
      tokens: { inputTokens: 0, outputTokens: 0, costUsd: COST_PER_STEP },
      durationMs: 10,
      recordedAt: now,
    }];

    const previousCost = COST_PER_STEP; // $0.10 from the single completed step

    const fakeRun: ExecutionRun = {
      runId,
      status: 'running',
      config: { name: 'cost-workflow', heartbeatIntervalMs: 10000, staleTimeoutMs: 30000 },
      metadata: {},
      totals: { cost: previousCost, tokens: 0, steps: 1, recoveryCount: 0 },
      createdAt: now,
      updatedAt: now,
      lastHeartbeat: now,
    };

    const store = {
      getRun: vi.fn().mockResolvedValue(fakeRun),
      listSteps: vi.fn().mockResolvedValue(completedSteps),
      listOutcomes: vi.fn().mockImplementation((stepId: string) =>
        Promise.resolve(existingOutcomes.filter((o) => o.stepId === stepId)),
      ),
      updateRun: vi.fn().mockResolvedValue({ ...fakeRun, status: 'completed' }),
      updateHeartbeat: vi.fn().mockResolvedValue(undefined),
      createStep: vi.fn().mockImplementation((step) => Promise.resolve({ ...step, completedAt: undefined })),
      updateStep: vi.fn().mockImplementation((stepId, updates) => Promise.resolve({ stepId, ...updates })),
      recordOutcome: vi.fn().mockImplementation((outcome) => Promise.resolve(outcome)),
      getOutcomeByKey: vi.fn().mockResolvedValue(null),
      findStaleRuns: vi.fn().mockResolvedValue([]),
      createRun: vi.fn().mockResolvedValue(fakeRun),
      getStep: vi.fn().mockResolvedValue(null),
      getOutcome: vi.fn().mockResolvedValue(null),
      listRuns: vi.fn().mockResolvedValue([]),
      deleteRun: vi.fn().mockResolvedValue(undefined),
      deleteRunsOlderThan: vi.fn().mockResolvedValue(0),
    };

    const engine = new RecoveryEngine(store as unknown as JournalStore, eventBus, 30000);

    // Replay the already-completed step
    const workflowFn = async (ctx: DurableContextImpl) => {
      await ctx.step('step-a', () => 'result-0');
      return 'done';
    };

    await engine.recover(runId, workflowFn, 'input');

    // The updateRun call at end of recovery preserves the existing totals.cost
    const updateCall = store.updateRun.mock.calls[0];
    expect(updateCall[1].totals.cost).toBeCloseTo(previousCost);
    expect(updateCall[1].totals.recoveryCount).toBe(1);
  });

  it('budget:exceeded fires when accumulated cost exceeds maxCostUsd', async () => {
    const { store } = createCostTrackingStore();
    const exceededEvents: BudgetExceededEvent[] = [];
    eventBus.on('budget:exceeded', (e) => exceededEvents.push(e));

    // Budget: $0.25. Each step costs $0.10.
    // After 3 steps: total = $0.30 which exceeds $0.25.
    // The budget check fires BEFORE the next step, so:
    // - Step 1 completes ($0.10) — budget check before step 2: ok
    // - Step 2 completes ($0.20) — budget check before step 3: ok
    // - Step 3 completes ($0.30) — budget check before step 4: exceeded
    const workflow = new DurableWorkflow(
      'cost-workflow',
      async (ctx) => {
        await ctx.step('step-1', () => 'a');
        await ctx.step('step-2', () => 'b');
        await ctx.step('step-3', () => 'c');
        // Step 4 triggers the budget check that sees $0.30 > $0.25
        await ctx.step('step-4', () => 'd');
        return 'done';
      },
      {
        store: store as unknown as JournalStore,
        eventBus,
        budget: { maxCostUsd: 0.25 },
      },
    );

    await workflow.run('input');

    expect(exceededEvents.length).toBeGreaterThanOrEqual(1);
    expect(exceededEvents[0].type).toBe('budget:exceeded');
    expect(exceededEvents[0].currentCost).toBeCloseTo(0.30);
    expect(exceededEvents[0].budgetLimit).toBe(0.25);
    expect(exceededEvents[0].action).toBe('graceful_stop');
  });
});

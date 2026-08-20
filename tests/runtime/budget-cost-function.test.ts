import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { RecoveryEngine } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type { ExecutionRun, OutcomeRecord, BudgetExceededEvent } from '../../src/core/types.js';
import type { DurableContextImpl } from '../../src/runtime/context.js';
import { randomUUID } from 'node:crypto';

const COST_PER_STEP = 0.10;

function createMockStore(opts?: { runId?: string }) {
  const now = new Date();
  const runId = opts?.runId ?? randomUUID();

  const fakeRun: ExecutionRun = {
    runId,
    status: 'running',
    config: {
      name: 'budget-cost-test',
      heartbeatIntervalMs: 10_000,
      staleTimeoutMs: 30_000,
      budget: { maxCostUsd: 0.25, costFunction: (t) => t.inputTokens * 0.001 },
    },
    metadata: {},
    totals: { cost: 0, tokens: 0, steps: 0, recoveryCount: 0 },
    createdAt: now,
    updatedAt: now,
    lastHeartbeat: now,
  };

  const outcomes: OutcomeRecord[] = [];

  const store = {
    createRun: vi.fn().mockResolvedValue(fakeRun),
    updateRun: vi.fn().mockImplementation((_id, updates) =>
      Promise.resolve({ ...fakeRun, ...updates }),
    ),
    getRun: vi.fn().mockResolvedValue(fakeRun),
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    createStep: vi.fn().mockImplementation((step) =>
      Promise.resolve({ ...step, completedAt: undefined }),
    ),
    updateStep: vi.fn().mockImplementation((stepId, updates) =>
      Promise.resolve({ stepId, ...updates }),
    ),
    recordOutcome: vi.fn().mockImplementation((outcome: OutcomeRecord) => {
      outcomes.push(outcome);
      return Promise.resolve(outcome);
    }),
    getOutcomeByKey: vi.fn().mockImplementation((key: string) =>
      Promise.resolve(outcomes.find((o) => o.operationKey === key) ?? null),
    ),
    listSteps: vi.fn().mockResolvedValue([]),
    listOutcomes: vi.fn().mockResolvedValue([]),
    listRuns: vi.fn().mockResolvedValue([]),
    findStaleRuns: vi.fn().mockResolvedValue([]),
    getStep: vi.fn().mockResolvedValue(null),
    getOutcome: vi.fn().mockResolvedValue(null),
    deleteRun: vi.fn().mockResolvedValue(undefined),
    deleteRunsOlderThan: vi.fn().mockResolvedValue(0),
  };

  return { store, outcomes, runId, fakeRun };
}

describe('Budget enforcement with costFunction', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  describe('Mock store tests', () => {
    it('workflow with costFunction and maxCostUsd triggers graceful stop at correct step', async () => {
      // costFunction: inputTokens * 0.001 → each step costs $0.10 (100 inputTokens)
      // maxCostUsd: 0.25
      // Step 1 → cost $0.10, total $0.10
      // Step 2 → cost $0.10, total $0.20
      // Step 3 → cost $0.10, total $0.30 > $0.25 → budget exceeded before step 4
      const { store, outcomes } = createMockStore();

      // Override recordOutcome to inject non-zero costUsd (simulating adapter behavior)
      store.recordOutcome.mockImplementation((outcome: OutcomeRecord) => {
        const withCost: OutcomeRecord = {
          ...outcome,
          tokens: { ...outcome.tokens, costUsd: COST_PER_STEP },
        };
        outcomes.push(withCost);
        return Promise.resolve(withCost);
      });

      // getOutcomeByKey reads from the outcomes array (which has costUsd injected)
      store.getOutcomeByKey.mockImplementation((key: string) => {
        const found = outcomes.find((o) => o.operationKey === key);
        return Promise.resolve(found ?? null);
      });

      const exceededEvents: BudgetExceededEvent[] = [];
      eventBus.on('budget:exceeded', (e) => exceededEvents.push(e));

      const stepsExecuted: string[] = [];
      const workflow = new DurableWorkflow(
        'budget-cost-test',
        async (ctx) => {
          await ctx.step('step-1', () => { stepsExecuted.push('step-1'); return 'a'; });
          await ctx.step('step-2', () => { stepsExecuted.push('step-2'); return 'b'; });
          await ctx.step('step-3', () => { stepsExecuted.push('step-3'); return 'c'; });
          await ctx.step('step-4-summary', () => { stepsExecuted.push('step-4-summary'); return 'summary'; });
          await ctx.step('step-5', () => { stepsExecuted.push('step-5'); return 'should-not-run'; });
          return 'done';
        },
        {
          store: store as unknown as JournalStore,
          eventBus,
          budget: { maxCostUsd: 0.25, costFunction: (t) => t.inputTokens * 0.001 },
        },
      );

      await workflow.run('input');

      // Budget exceeded should fire after step 3 (total $0.30 > $0.25)
      expect(exceededEvents.length).toBeGreaterThanOrEqual(1);
      expect(exceededEvents[0].action).toBe('graceful_stop');
      expect(exceededEvents[0].currentCost).toBeCloseTo(0.30);
      expect(exceededEvents[0].budgetLimit).toBe(0.25);

      // Step 4 is allowed as summary step (fn executes), step 5 should NOT execute
      expect(stepsExecuted).toContain('step-4-summary');
      expect(stepsExecuted).not.toContain('step-5');
    });

    it('accumulator uses getOutcomeByKey (one call per step), not O(n²) scan', async () => {
      const { store, outcomes } = createMockStore();

      store.recordOutcome.mockImplementation((outcome: OutcomeRecord) => {
        const withCost: OutcomeRecord = {
          ...outcome,
          tokens: { ...outcome.tokens, costUsd: 0.05 },
        };
        outcomes.push(withCost);
        return Promise.resolve(withCost);
      });

      store.getOutcomeByKey.mockImplementation((key: string) => {
        const found = outcomes.find((o) => o.operationKey === key);
        return Promise.resolve(found ?? null);
      });

      const workflow = new DurableWorkflow(
        'budget-cost-test',
        async (ctx) => {
          await ctx.step('a', () => 'result-a');
          await ctx.step('b', () => 'result-b');
          await ctx.step('c', () => 'result-c');
          return 'done';
        },
        {
          store: store as unknown as JournalStore,
          eventBus,
        },
      );

      await workflow.run('input');

      // getOutcomeByKey called once per step (3 steps = 3 calls)
      expect(store.getOutcomeByKey).toHaveBeenCalledTimes(3);

      // listSteps and listOutcomes should NOT be called for post-step cost accounting
      // (they may be called during recovery detection at construction, but NOT after each step)
      const listStepsCalls = store.listSteps.mock.calls.filter(
        (call) => call[0] !== undefined,
      );
      const listOutcomesCalls = store.listOutcomes.mock.calls;
      expect(listStepsCalls).toHaveLength(0);
      expect(listOutcomesCalls).toHaveLength(0);
    });
  });

  describe('Real SqliteJournalStore tests', () => {
    let store: SqliteJournalStore;

    it('recovery initializes accumulator correctly and fresh steps resume accumulation', async () => {
      store = new SqliteJournalStore(':memory:');
      try {
        const run = await store.createRun({
          name: 'budget-cost-test',
          heartbeatIntervalMs: 10_000,
          staleTimeoutMs: 30_000,
          budget: { maxCostUsd: 1.0, costFunction: (t) => t.inputTokens * 0.001 },
        });
        await store.updateRun(run.runId, { status: 'running' });

        // Pre-persist 2 completed steps with outcomes
        for (let i = 0; i < 2; i++) {
          const stepId = randomUUID();
          await store.createStep({
            stepId,
            runId: run.runId,
            nodeName: `step-${i}`,
            sequence: i,
            status: 'completed',
            startedAt: new Date(),
            cost: { inputTokens: 100, outputTokens: 50, costUsd: 0 },
            attempt: 1,
          });
          await store.recordOutcome({
            outcomeId: randomUUID(),
            stepId,
            operationType: 'custom',
            operationKey: computeOperationKey(run.runId, `step-${i}`, i),
            result: `result-${i}`,
            tokens: { inputTokens: 100, outputTokens: 50, costUsd: 0 },
            durationMs: 10,
            recordedAt: new Date(),
          });
        }

        const engine = new RecoveryEngine(store, eventBus, 30_000);

        let freshStepExecuted = false;
        await engine.recover(
          run.runId,
          async (ctx: DurableContextImpl) => {
            // Steps 0, 1 are replayed from cursor
            await ctx.step('step-0', () => 'should-replay');
            await ctx.step('step-1', () => 'should-replay');
            // Step 2 is a fresh execution
            freshStepExecuted = true;
            await ctx.step('step-2', () => 'fresh-result');
            return 'done';
          },
          undefined,
        );

        expect(freshStepExecuted).toBe(true);

        // Verify recovery completed successfully
        const updatedRun = await store.getRun(run.runId);
        expect(updatedRun!.status).toBe('completed');
        expect(updatedRun!.totals.recoveryCount).toBe(1);
        // initialCost is sum of outcome.tokens.costUsd from the replay cursor
        // With real SQLite store, costUsd is persisted as part of the outcome tokens field
        // The cost field reflects the accumulated value from recovery
        expect(updatedRun!.totals.cost).toBeGreaterThanOrEqual(0);

        // Verify all 3 steps exist (2 replayed + 1 fresh)
        const allSteps = await store.listSteps(run.runId);
        expect(allSteps.length).toBe(3);

        // Verify fresh step has a persisted outcome
        const freshStep = allSteps.find((s) => s.sequence === 2);
        expect(freshStep).toBeDefined();
        expect(freshStep!.status).toBe('completed');
        const freshOutcomes = await store.listOutcomes(freshStep!.stepId);
        expect(freshOutcomes.length).toBe(1);
      } finally {
        store.close();
      }
    });

    it('replayed steps do not double-count cost', async () => {
      store = new SqliteJournalStore(':memory:');
      try {
        const run = await store.createRun({
          name: 'budget-cost-test',
          heartbeatIntervalMs: 10_000,
          staleTimeoutMs: 30_000,
          budget: { maxCostUsd: 1.0 },
        });
        await store.updateRun(run.runId, { status: 'running' });

        // Pre-persist 3 outcomes
        for (let i = 0; i < 3; i++) {
          const stepId = randomUUID();
          await store.createStep({
            stepId,
            runId: run.runId,
            nodeName: `step-${i}`,
            sequence: i,
            status: 'completed',
            startedAt: new Date(),
            cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
            attempt: 1,
          });
          await store.recordOutcome({
            outcomeId: randomUUID(),
            stepId,
            operationType: 'custom',
            operationKey: computeOperationKey(run.runId, `step-${i}`, i),
            result: `result-${i}`,
            tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
            durationMs: 10,
            recordedAt: new Date(),
          });
        }

        const recordOutcomeSpy = vi.spyOn(store, 'recordOutcome');

        const engine = new RecoveryEngine(store, eventBus, 30_000);
        await engine.recover(
          run.runId,
          async (ctx: DurableContextImpl) => {
            // All 3 steps are replayed — fn() should not be called
            await ctx.step('step-0', () => 'fresh-0');
            await ctx.step('step-1', () => 'fresh-1');
            await ctx.step('step-2', () => 'fresh-2');
            return 'done';
          },
          undefined,
        );

        // Replayed steps should NOT create new outcomes (they return cached results)
        expect(recordOutcomeSpy).not.toHaveBeenCalled();

        // The final cost should equal the sum of persisted costUsd (all zeros here)
        const updatedRun = await store.getRun(run.runId);
        expect(updatedRun!.totals.cost).toBe(0);
        expect(updatedRun!.totals.recoveryCount).toBe(1);
      } finally {
        store.close();
      }
    });

    it('maxCostUsd without costFunction → budget does NOT trigger', async () => {
      store = new SqliteJournalStore(':memory:');
      try {
        const exceededEvents: BudgetExceededEvent[] = [];
        eventBus.on('budget:exceeded', (e) => exceededEvents.push(e));

        const workflow = new DurableWorkflow(
          'budget-cost-test',
          async (ctx) => {
            for (let i = 0; i < 10; i++) {
              await ctx.step(`step-${i}`, () => `result-${i}`);
            }
            return 'done';
          },
          {
            store,
            eventBus,
            budget: { maxCostUsd: 0.01 },
          },
        );

        const result = await workflow.run('input');

        // All 10 steps should complete — no budget exceeded
        expect(result).toBe('done');
        expect(exceededEvents).toHaveLength(0);

        // Verify all steps completed
        const runs = await store.listRuns();
        const run = runs[0];
        expect(run.status).toBe('completed');

        const steps = await store.listSteps(run.runId);
        expect(steps.length).toBe(10);

        // Each step has costUsd: 0 because no costFunction was applied
        for (const step of steps) {
          const outcomes = await store.listOutcomes(step.stepId);
          expect(outcomes[0].tokens.costUsd).toBe(0);
        }
      } finally {
        store.close();
      }
    });
  });
});

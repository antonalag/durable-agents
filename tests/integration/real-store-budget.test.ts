import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type { OutcomeRecord, BudgetConfig } from '../../src/core/types.js';

type CostFn = NonNullable<BudgetConfig['costFunction']>;

/**
 * Delegates every call to a real SqliteJournalStore, only assigning a per-step
 * cost inside recordOutcome — the way an adapter assigns cost before
 * persisting. Persistence stays real, so a missing cost_usd column would still
 * surface as a failing round trip.
 */
class CostInjectingStore implements JournalStore {
  constructor(
    private readonly inner: SqliteJournalStore,
    private readonly costPerOutcome: number,
  ) {}

  createRun = (...args: Parameters<JournalStore['createRun']>) =>
    this.inner.createRun(...args);
  getRun = (...args: Parameters<JournalStore['getRun']>) =>
    this.inner.getRun(...args);
  updateRun = (...args: Parameters<JournalStore['updateRun']>) =>
    this.inner.updateRun(...args);
  listRuns = (...args: Parameters<JournalStore['listRuns']>) =>
    this.inner.listRuns(...args);
  deleteRun = (...args: Parameters<JournalStore['deleteRun']>) =>
    this.inner.deleteRun(...args);
  createStep = (...args: Parameters<JournalStore['createStep']>) =>
    this.inner.createStep(...args);
  getStep = (...args: Parameters<JournalStore['getStep']>) =>
    this.inner.getStep(...args);
  updateStep = (...args: Parameters<JournalStore['updateStep']>) =>
    this.inner.updateStep(...args);
  listSteps = (...args: Parameters<JournalStore['listSteps']>) =>
    this.inner.listSteps(...args);
  getOutcome = (...args: Parameters<JournalStore['getOutcome']>) =>
    this.inner.getOutcome(...args);
  getOutcomeByKey = (...args: Parameters<JournalStore['getOutcomeByKey']>) =>
    this.inner.getOutcomeByKey(...args);
  listOutcomes = (...args: Parameters<JournalStore['listOutcomes']>) =>
    this.inner.listOutcomes(...args);
  updateHeartbeat = (...args: Parameters<JournalStore['updateHeartbeat']>) =>
    this.inner.updateHeartbeat(...args);
  findStaleRuns = (...args: Parameters<JournalStore['findStaleRuns']>) =>
    this.inner.findStaleRuns(...args);
  claimRunForRecovery = (
    ...args: Parameters<JournalStore['claimRunForRecovery']>
  ) => this.inner.claimRunForRecovery(...args);
  deleteRunsOlderThan = (
    ...args: Parameters<JournalStore['deleteRunsOlderThan']>
  ) => this.inner.deleteRunsOlderThan(...args);

  recordOutcome(
    outcome: OutcomeRecord,
    expectedGeneration: number,
  ): Promise<OutcomeRecord> {
    return this.inner.recordOutcome(
      {
        ...outcome,
        tokens: { ...outcome.tokens, costUsd: this.costPerOutcome },
      },
      expectedGeneration,
    );
  }
}

describe('Real-store budget integration', () => {
  it('costUsd round-trips through a real SqliteJournalStore to > 0', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const costFn: CostFn = ({ inputTokens }) => inputTokens * 0.002;
      const run = await store.createRun({ name: 'real-store-round-trip' });
      const stepId = randomUUID();
      await store.createStep({
        stepId,
        runId: run.runId,
        nodeName: 'llm-step',
        sequence: 0,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      }, 0);

      const operationKey = computeOperationKey(run.runId, 'llm-step', 0);
      const expectedCost = costFn({ inputTokens: 100, outputTokens: 20 });
      await store.recordOutcome({
        outcomeId: randomUUID(),
        stepId,
        operationType: 'llm_call',
        operationKey,
        result: 'answer',
        tokens: { inputTokens: 100, outputTokens: 20, costUsd: expectedCost },
        durationMs: 5,
        recordedAt: new Date(),
      }, 0);

      const read = await store.getOutcomeByKey(operationKey);
      expect(read).not.toBeNull();
      expect(read!.tokens.costUsd).toBeGreaterThan(0);
      expect(read!.tokens.costUsd).toBe(expectedCost);
    } finally {
      store.close();
    }
  });

  it('exceeding maxCostUsd against a real store triggers a graceful stop end-to-end', async () => {
    const inner = new SqliteJournalStore(':memory:');
    try {
      const costPerStep = 0.1;
      const store = new CostInjectingStore(inner, costPerStep);
      const eventBus = new EventBus();

      const exceededCosts: number[] = [];
      eventBus.on('budget:exceeded', (e) => exceededCosts.push(e.currentCost));

      const executed: string[] = [];
      const workflow = new DurableWorkflow(
        'real-store-budget-stop',
        async (ctx) => {
          for (let i = 0; i < 6; i++) {
            await ctx.step(`step-${i}`, () => {
              executed.push(`step-${i}`);
              return `result-${i}`;
            });
          }
          return 'done';
        },
        {
          store: store as unknown as JournalStore,
          eventBus,
          budget: { maxCostUsd: 0.25 },
        },
      );

      // costPerStep 0.10, maxCostUsd 0.25:
      // after step-2 accumulated cost is 0.30 > 0.25 → graceful stop before step-3
      await workflow.run('input');

      const runs = await inner.listRuns();
      const run = runs[0];

      expect(run.status).toBe('terminated');
      expect(run.metadata.terminationReason).toBe('budget_exceeded');
      // The accumulated observed cost (read back from the real store per step)
      // must have crossed the limit for the budget check to fire.
      expect(exceededCosts.length).toBeGreaterThanOrEqual(1);
      expect(exceededCosts[0]).toBeGreaterThan(0.25);
      // step-3 onward should be gated (step-3 may run as summary, later steps must not).
      expect(executed).not.toContain('step-5');
    } finally {
      inner.close();
    }
  });
});

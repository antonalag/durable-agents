import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RecoveryEngine } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type { DurableContextImpl } from '../../src/runtime/context.js';
import type { OutcomeRecord, RunConfig } from '../../src/core/types.js';

/**
 * Wraps a real SqliteJournalStore and stamps a fixed cost on every persisted
 * outcome, mimicking how an adapter attaches cost before persistence. Real
 * persistence is preserved so recovery reads back real costs.
 */
class CostInjectingStore implements JournalStore {
  constructor(
    private readonly inner: SqliteJournalStore,
    private readonly costPerOutcome: number,
  ) {}

  createRun = (...a: Parameters<JournalStore['createRun']>) => this.inner.createRun(...a);
  getRun = (...a: Parameters<JournalStore['getRun']>) => this.inner.getRun(...a);
  updateRun = (...a: Parameters<JournalStore['updateRun']>) => this.inner.updateRun(...a);
  listRuns = (...a: Parameters<JournalStore['listRuns']>) => this.inner.listRuns(...a);
  deleteRun = (...a: Parameters<JournalStore['deleteRun']>) => this.inner.deleteRun(...a);
  createStep = (...a: Parameters<JournalStore['createStep']>) => this.inner.createStep(...a);
  getStep = (...a: Parameters<JournalStore['getStep']>) => this.inner.getStep(...a);
  updateStep = (...a: Parameters<JournalStore['updateStep']>) => this.inner.updateStep(...a);
  listSteps = (...a: Parameters<JournalStore['listSteps']>) => this.inner.listSteps(...a);
  getOutcome = (...a: Parameters<JournalStore['getOutcome']>) => this.inner.getOutcome(...a);
  getOutcomeByKey = (...a: Parameters<JournalStore['getOutcomeByKey']>) => this.inner.getOutcomeByKey(...a);
  listOutcomes = (...a: Parameters<JournalStore['listOutcomes']>) => this.inner.listOutcomes(...a);
  updateHeartbeat = (...a: Parameters<JournalStore['updateHeartbeat']>) => this.inner.updateHeartbeat(...a);
  findStaleRuns = (...a: Parameters<JournalStore['findStaleRuns']>) => this.inner.findStaleRuns(...a);
  claimRunForRecovery = (...a: Parameters<JournalStore['claimRunForRecovery']>) => this.inner.claimRunForRecovery(...a);
  deleteRunsOlderThan = (...a: Parameters<JournalStore['deleteRunsOlderThan']>) => this.inner.deleteRunsOlderThan(...a);

  recordOutcome(outcome: OutcomeRecord, expectedGeneration: number): Promise<OutcomeRecord> {
    return this.inner.recordOutcome(
      { ...outcome, tokens: { ...outcome.tokens, costUsd: this.costPerOutcome } },
      expectedGeneration,
    );
  }
}

/**
 * Seeds a real store with a run in 'running' state whose first `preCrashSteps`
 * steps are completed and journaled with the given per-step cost, simulating a
 * process that crashed mid-workflow. Returns the runId.
 */
async function seedCrashedRun(
  store: JournalStore,
  opts: { config: RunConfig; preCrashSteps: number; costPerStep: number },
): Promise<string> {
  const run = await store.createRun(opts.config);
  await store.updateRun(run.runId, { status: 'running' }, 0);

  let cost = 0;
  for (let i = 0; i < opts.preCrashSteps; i++) {
    const stepId = randomUUID();
    const nodeName = `step-${i}`;
    await store.createStep({
      stepId,
      runId: run.runId,
      nodeName,
      sequence: i,
      status: 'completed',
      startedAt: new Date(),
      cost: { inputTokens: 0, outputTokens: 0, costUsd: opts.costPerStep },
      attempt: 1,
    }, 0);
    await store.recordOutcome({
      outcomeId: randomUUID(),
      stepId,
      operationType: 'custom',
      operationKey: computeOperationKey(run.runId, nodeName, i),
      result: `result-${i}`,
      tokens: { inputTokens: 0, outputTokens: 0, costUsd: opts.costPerStep },
      durationMs: 1,
      recordedAt: new Date(),
    }, 0);
    cost += opts.costPerStep;
  }

  await store.updateRun(run.runId, {
    status: 'running',
    totals: { cost, tokens: 0, steps: opts.preCrashSteps, recoveryCount: 0 },
  }, 0);

  return run.runId;
}

describe('recovery enforces the same governance as normal execution', () => {
  it('gracefully stops a recovered run once fresh steps cross maxCostUsd', async () => {
    const inner = new SqliteJournalStore(':memory:');
    try {
      const costPerStep = 0.1;
      const store = new CostInjectingStore(inner, costPerStep);
      const eventBus = new EventBus();
      const exceeded: number[] = [];
      eventBus.on('budget:exceeded', (e) => exceeded.push(e.currentCost));

      // 2 pre-crash steps ($0.20), budget $0.35. Replays cost nothing new; fresh
      // steps add $0.10 each: after fresh step-2 total is $0.30 (ok), after
      // fresh step-3 total is $0.40 > $0.35 → stop before the next step.
      const runId = await seedCrashedRun(store, {
        config: { name: 'gov-cost', budget: { maxCostUsd: 0.35 } },
        preCrashSteps: 2,
        costPerStep,
      });

      const executed: string[] = [];
      const workflowFn = async (ctx: DurableContextImpl) => {
        for (let i = 0; i < 6; i++) {
          await ctx.step(`step-${i}`, () => {
            executed.push(`step-${i}`);
            return `result-${i}`;
          });
        }
        return 'done';
      };

      const engine = new RecoveryEngine(store, eventBus, 30_000);
      await engine.recover(runId, workflowFn, null, 0);

      const run = await inner.getRun(runId);
      expect(run!.status).toBe('terminated');
      expect(run!.metadata.terminationReason).toBe('budget_exceeded');
      expect(exceeded.length).toBeGreaterThanOrEqual(1);
      // The two replayed steps did not re-execute the body.
      expect(executed).not.toContain('step-0');
      expect(executed).not.toContain('step-1');
      // Later fresh steps were gated once the budget was crossed.
      expect(executed).not.toContain('step-5');
    } finally {
      inner.close();
    }
  });

  it('gracefully stops a recovered run once fresh steps cross maxSteps', async () => {
    const inner = new SqliteJournalStore(':memory:');
    try {
      const store = new CostInjectingStore(inner, 0);
      const eventBus = new EventBus();
      const exceeded: string[] = [];
      eventBus.on('budget:exceeded', () => exceeded.push('x'));

      // 2 pre-crash steps counted; maxSteps 4. Replays do not re-count, so the
      // cumulative count resumes at 2 and fresh steps push it to the limit.
      const runId = await seedCrashedRun(store, {
        config: { name: 'gov-steps', budget: { maxSteps: 4 } },
        preCrashSteps: 2,
        costPerStep: 0,
      });

      const executed: string[] = [];
      const workflowFn = async (ctx: DurableContextImpl) => {
        for (let i = 0; i < 8; i++) {
          await ctx.step(`step-${i}`, () => {
            executed.push(`step-${i}`);
            return `result-${i}`;
          });
        }
        return 'done';
      };

      const engine = new RecoveryEngine(store, eventBus, 30_000);
      await engine.recover(runId, workflowFn, null, 0);

      const run = await inner.getRun(runId);
      expect(run!.status).toBe('terminated');
      expect(exceeded.length).toBeGreaterThanOrEqual(1);
      expect(executed).not.toContain('step-7');
    } finally {
      inner.close();
    }
  });

  it('stops a recovered run whose fresh steps repeat the same tool', async () => {
    const inner = new SqliteJournalStore(':memory:');
    try {
      const store = new CostInjectingStore(inner, 0);
      const eventBus = new EventBus();
      let loopDetected = false;
      eventBus.on('loop:detected', () => {
        loopDetected = true;
      });

      const runId = await seedCrashedRun(store, {
        config: {
          name: 'gov-loop',
          loopDetection: { windowSize: 10, maxRepetitions: 3, action: 'graceful_stop' },
        },
        preCrashSteps: 1,
        costPerStep: 0,
      });

      const executed: string[] = [];
      const workflowFn = async (ctx: DurableContextImpl) => {
        // step-0 replays; the rest hammer the same tool name to trip same-tool detection.
        await ctx.step('step-0', () => 'result-0');
        for (let i = 0; i < 8; i++) {
          await ctx.step('same-tool', () => {
            executed.push(`same-${i}`);
            return `v-${i}`;
          });
        }
        return 'done';
      };

      const engine = new RecoveryEngine(store, eventBus, 30_000);
      await engine.recover(runId, workflowFn, null, 0);

      const run = await inner.getRun(runId);
      expect(loopDetected).toBe(true);
      expect(run!.status).toBe('terminated');
    } finally {
      inner.close();
    }
  });

  it('final persisted cost and step totals include fresh recovery steps without double-counting replays', async () => {
    const inner = new SqliteJournalStore(':memory:');
    try {
      const costPerStep = 0.1;
      const store = new CostInjectingStore(inner, costPerStep);
      const eventBus = new EventBus();

      // 2 pre-crash steps ($0.20). Recovery replays those 2 and runs 3 fresh.
      const runId = await seedCrashedRun(store, {
        config: { name: 'gov-totals' },
        preCrashSteps: 2,
        costPerStep,
      });

      const workflowFn = async (ctx: DurableContextImpl) => {
        await ctx.step('step-0', () => 'result-0'); // replay
        await ctx.step('step-1', () => 'result-1'); // replay
        await ctx.step('step-2', () => 'result-2'); // fresh
        await ctx.step('step-3', () => 'result-3'); // fresh
        await ctx.step('step-4', () => 'result-4'); // fresh
        return 'done';
      };

      const engine = new RecoveryEngine(store, eventBus, 30_000);
      const result = await engine.recover(runId, workflowFn, null, 0);
      expect(result).toBe('done');

      const run = await inner.getRun(runId);
      expect(run!.status).toBe('completed');
      // 2 pre-crash + 3 fresh, replays not re-counted.
      expect(run!.totals.steps).toBe(5);
      // $0.20 baseline + 3 fresh × $0.10, replays add nothing.
      expect(run!.totals.cost).toBeCloseTo(0.5, 6);
      expect(run!.totals.recoveryCount).toBe(1);
    } finally {
      inner.close();
    }
  });
});

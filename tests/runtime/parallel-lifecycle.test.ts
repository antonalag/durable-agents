import { describe, it, expect } from 'vitest';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type { OutcomeRecord } from '../../src/core/types.js';

class KeyedCostStore implements JournalStore {
  readonly costByKey = new Map<string, number>();

  constructor(private readonly inner: SqliteJournalStore) {}

  createRun = (c: Parameters<JournalStore['createRun']>[0]) => this.inner.createRun(c);
  getRun = (id: string) => this.inner.getRun(id);
  updateRun = (id: string, u: Parameters<JournalStore['updateRun']>[1]) =>
    this.inner.updateRun(id, u);
  listRuns = (f?: Parameters<JournalStore['listRuns']>[0]) => this.inner.listRuns(f);
  deleteRun = (id: string) => this.inner.deleteRun(id);
  createStep = (s: Parameters<JournalStore['createStep']>[0]) => this.inner.createStep(s);
  getStep = (id: string) => this.inner.getStep(id);
  updateStep = (id: string, u: Parameters<JournalStore['updateStep']>[1]) =>
    this.inner.updateStep(id, u);
  listSteps = (id: string) => this.inner.listSteps(id);
  getOutcome = (id: string) => this.inner.getOutcome(id);
  getOutcomeByKey = (k: string) => this.inner.getOutcomeByKey(k);
  listOutcomes = (id: string) => this.inner.listOutcomes(id);
  updateHeartbeat = (id: string) => this.inner.updateHeartbeat(id);
  findStaleRuns = (t: number) => this.inner.findStaleRuns(t);
  claimRunForRecovery = (id: string) => this.inner.claimRunForRecovery(id);
  deleteRunsOlderThan = (m: number) => this.inner.deleteRunsOlderThan(m);

  recordOutcome(outcome: OutcomeRecord): Promise<OutcomeRecord> {
    const cost = this.costByKey.get(outcome.operationKey) ?? 0;
    return this.inner.recordOutcome({
      ...outcome,
      tokens: { ...outcome.tokens, costUsd: cost },
    });
  }
}

describe('parallel lifecycle gating', () => {
  it('runs a parallel group normally while the run is active', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const workflow = new DurableWorkflow(
        'parallel-active',
        async (ctx) => {
          const results = await ctx.parallel([
            { name: 'a', fn: () => 1 },
            { name: 'b', fn: () => 2 },
          ]);
          return results;
        },
        { store },
      );

      const result = await workflow.run('input');
      expect(result).toEqual([1, 2]);

      const runs = await store.listRuns();
      expect(runs[0].status).toBe('completed');
      expect(runs[0].totals.steps).toBe(2);
    } finally {
      store.close();
    }
  });

  it('blocks the whole parallel group once the run is stopping', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      let parallelReached = false;
      let parallelThrew = false;

      const workflow = new DurableWorkflow(
        'parallel-stopping',
        async (ctx) => {
          // maxSteps=1: step-0 runs, step-1 triggers graceful stop and is the
          // summary step; the parallel group after it must be blocked.
          await ctx.step('step-0', () => 'a');
          await ctx.step('step-1-summary', () => 'b');
          parallelReached = true;
          try {
            await ctx.parallel([{ name: 'p', fn: () => 'c' }]);
          } catch (err) {
            parallelThrew =
              err instanceof DOMException && err.name === 'AbortError';
            throw err;
          }
          return 'done';
        },
        { store, budget: { maxSteps: 1 } },
      );

      await workflow.run('input');

      expect(parallelReached).toBe(true);
      expect(parallelThrew).toBe(true);

      const runs = await store.listRuns();
      expect(runs[0].status).toBe('terminated');
    } finally {
      store.close();
    }
  });

  it('a parallel group whose cost crosses maxCostUsd gates the next step', async () => {
    const inner = new SqliteJournalStore(':memory:');
    try {
      const store = new KeyedCostStore(inner);
      const eventBus = new EventBus();
      const branchNames = ['x', 'y', 'z'];

      eventBus.on('run:started', (e) => {
        branchNames.forEach((name, i) => {
          store.costByKey.set(computeOperationKey(e.runId, name, i), 0.2);
        });
      });

      let summaryRan = false;
      let blockedStepRan = false;
      const exceeded: number[] = [];
      eventBus.on('budget:exceeded', (e) => exceeded.push(e.currentCost));

      const workflow = new DurableWorkflow(
        'parallel-budget',
        async (ctx) => {
          await ctx.parallel(branchNames.map((name) => ({ name, fn: () => name })));
          await ctx.step('summary', () => {
            summaryRan = true;
            return 'summary';
          });
          await ctx.step('blocked', () => {
            blockedStepRan = true;
            return 'blocked';
          });
          return 'done';
        },
        { store: store as unknown as JournalStore, eventBus, budget: { maxCostUsd: 0.25 } },
      );

      await workflow.run('input');

      // Group cost 0.6 > 0.25 → graceful stop; the next step runs as the single
      // summary allowance, and the step after that is blocked → run terminates.
      expect(exceeded.length).toBeGreaterThanOrEqual(1);
      expect(exceeded[0]).toBeGreaterThan(0.25);
      expect(summaryRan).toBe(true);
      expect(blockedStepRan).toBe(false);

      const runs = await inner.listRuns();
      expect(runs[0].status).toBe('terminated');
      expect(runs[0].metadata.terminationReason).toBe('budget_exceeded');
    } finally {
      inner.close();
    }
  });

  it('propagates the first branch rejection without advancing group accounting', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      let caught: unknown;
      const workflow = new DurableWorkflow(
        'parallel-reject',
        async (ctx) => {
          try {
            await ctx.parallel([
              { name: 'ok', fn: () => 'ok' },
              {
                name: 'boom',
                fn: () => {
                  throw new Error('branch failure');
                },
              },
            ]);
          } catch (err) {
            caught = err;
            throw err;
          }
          return 'done';
        },
        { store },
      );

      await expect(workflow.run('input')).rejects.toThrow('branch failure');
      expect((caught as Error).message).toBe('branch failure');

      const runs = await store.listRuns();
      const run = runs[0];
      expect(run.status).toBe('failed');
      // Group accounting never advanced because the group threw before it.
      expect(run.totals.steps).toBe(0);
      expect(run.totals.cost).toBe(0);
    } finally {
      store.close();
    }
  });

  it('numbers loop-detection entries by running step count for a parallel group', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      // A group of identical-output branches large enough to trip no_progress.
      const workflow = new DurableWorkflow(
        'parallel-loop',
        async (ctx) => {
          await ctx.parallel(
            Array.from({ length: 5 }, (_, i) => ({
              name: `same-${i}`,
              fn: () => 'identical',
            })),
          );
          return 'done';
        },
        {
          store,
          loopDetection: { windowSize: 5, maxNoProgressSteps: 3, action: 'emit_only' },
        },
      );

      let detectedAtStep: number | undefined;
      workflow.on('loop:detected', (e) => {
        detectedAtStep = e.detectedAtStep;
      });

      await workflow.run('input');

      // The group of 5 occupies running-count positions 1..5; detection is
      // reported against the running step count, not an operation-key sequence.
      expect(detectedAtStep).toBe(5);

      const runs = await store.listRuns();
      expect(runs[0].totals.steps).toBe(5);
    } finally {
      store.close();
    }
  });
});

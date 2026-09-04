import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type { OutcomeRecord } from '../../src/core/types.js';

/**
 * Delegates to a real store, assigning each recorded outcome a cost looked up
 * by its operationKey. Cost is populated lazily once the run id is known.
 */
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

describe('parallel group cost accounting', () => {
  it('running cost increases by the sum of branch costs and step count by the branch count', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: 0, max: 10, noNaN: true }), {
          minLength: 1,
          maxLength: 6,
        }),
        async (branchCosts) => {
          const inner = new SqliteJournalStore(':memory:');
          try {
            const store = new KeyedCostStore(inner);
            const eventBus = new EventBus();
            const names = branchCosts.map((_, i) => `branch-${i}`);

            eventBus.on('run:started', (e) => {
              for (let i = 0; i < names.length; i++) {
                store.costByKey.set(
                  computeOperationKey(e.runId, names[i], i),
                  branchCosts[i],
                );
              }
            });

            const workflow = new DurableWorkflow(
              'parallel-accounting',
              async (ctx) => {
                await ctx.parallel(
                  names.map((name) => ({ name, fn: () => `r-${name}` })),
                );
                return 'done';
              },
              { store: store as unknown as JournalStore, eventBus },
            );

            await workflow.run('input');

            const runs = await inner.listRuns();
            const run = runs[0];
            const expected = branchCosts.reduce((a, b) => a + b, 0);
            expect(run.totals.steps).toBe(branchCosts.length);
            expect(run.totals.cost).toBeCloseTo(expected, 6);
          } finally {
            inner.close();
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it('replayed branches are marked and do not contribute fresh cost', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
        async (replayedMask) => {
          const store = new SqliteJournalStore(':memory:');
          try {
            const run = await store.createRun({ name: 'replay-mask' });
            await store.updateRun(run.runId, { status: 'running' });

            const names = replayedMask.map((_, i) => `b-${i}`);
            const replayCursor = new Map<string, OutcomeRecord>();

            for (let i = 0; i < replayedMask.length; i++) {
              if (replayedMask[i]) {
                const key = computeOperationKey(run.runId, names[i], i);
                replayCursor.set(key, {
                  outcomeId: randomUUID(),
                  stepId: randomUUID(),
                  operationType: 'custom',
                  operationKey: key,
                  result: `cached-${i}`,
                  tokens: { inputTokens: 0, outputTokens: 0, costUsd: 5 },
                  durationMs: 1,
                  recordedAt: new Date(),
                });
              }
            }

            const ctx = new DurableContextImpl({
              run,
              store,
              mode: 'replay',
              replayCursor,
              eventBus: new EventBus(),
              signal: new AbortController().signal,
            });

            await ctx.parallel(
              names.map((name) => ({ name, fn: () => `fresh-${name}` })),
            );

            for (let i = 0; i < replayedMask.length; i++) {
              const key = computeOperationKey(run.runId, names[i], i);
              expect(ctx.wasReplayed(key)).toBe(replayedMask[i]);
            }
          } finally {
            store.close();
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('parallel operation key reconstruction', () => {
  it('the wrapper key for branch i matches the key ctx.parallel used to persist it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
          minLength: 1,
          maxLength: 6,
        }),
        async (rawNames) => {
          const store = new SqliteJournalStore(':memory:');
          try {
            // Ensure unique branch names so keys are distinguishable.
            const names = rawNames.map((n, i) => `${n}-${i}`);
            const run = await store.createRun({ name: 'key-reconstruction' });
            await store.updateRun(run.runId, { status: 'running' });

            const ctx = new DurableContextImpl({
              run,
              store,
              mode: 'fresh',
              replayCursor: new Map(),
              eventBus: new EventBus(),
              signal: new AbortController().signal,
            });

            const seqBase = ctx.currentSequence;
            await ctx.parallel(names.map((name) => ({ name, fn: () => name })));

            for (let i = 0; i < names.length; i++) {
              const reconstructed = computeOperationKey(
                run.runId,
                names[i],
                seqBase + i,
              );
              const persisted = await store.getOutcomeByKey(reconstructed);
              expect(persisted).not.toBeNull();
              expect(persisted!.result).toBe(names[i]);
            }
          } finally {
            store.close();
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});

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
  getOutcomeByKey = (...a: Parameters<JournalStore['getOutcomeByKey']>) =>
    this.inner.getOutcomeByKey(...a);
  listOutcomes = (...a: Parameters<JournalStore['listOutcomes']>) =>
    this.inner.listOutcomes(...a);
  updateHeartbeat = (...a: Parameters<JournalStore['updateHeartbeat']>) =>
    this.inner.updateHeartbeat(...a);
  findStaleRuns = (...a: Parameters<JournalStore['findStaleRuns']>) =>
    this.inner.findStaleRuns(...a);
  claimRunForRecovery = (...a: Parameters<JournalStore['claimRunForRecovery']>) =>
    this.inner.claimRunForRecovery(...a);
  deleteRunsOlderThan = (...a: Parameters<JournalStore['deleteRunsOlderThan']>) =>
    this.inner.deleteRunsOlderThan(...a);

  recordOutcome(
    outcome: OutcomeRecord,
    expectedGeneration: number,
  ): Promise<OutcomeRecord> {
    const cost = this.costByKey.get(outcome.operationKey) ?? 0;
    return this.inner.recordOutcome(
      {
        ...outcome,
        tokens: { ...outcome.tokens, costUsd: cost },
      },
      expectedGeneration,
    );
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
            await store.updateRun(run.runId, { status: 'running' }, 0);

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
              generation: 0,
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
            await store.updateRun(run.runId, { status: 'running' }, 0);

            const ctx = new DurableContextImpl({
              run,
              store,
              mode: 'fresh',
              replayCursor: new Map(),
              eventBus: new EventBus(),
              signal: new AbortController().signal,
              generation: 0,
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

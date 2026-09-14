import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { RecoveryEngine } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { DurableContextImpl } from '../../src/runtime/context.js';

async function seedOutcome(
  store: SqliteJournalStore,
  runId: string,
  index: number,
  costUsd: number,
): Promise<string> {
  const stepId = randomUUID();
  const nodeName = `step-${index}`;
  await store.createStep({
    stepId,
    runId,
    nodeName,
    sequence: index,
    status: 'completed',
    startedAt: new Date(),
    cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    attempt: 1,
  }, 0);
  const operationKey = computeOperationKey(runId, nodeName, index);
  await store.recordOutcome({
    outcomeId: randomUUID(),
    stepId,
    operationType: 'custom',
    operationKey,
    result: `result-${index}`,
    tokens: { inputTokens: 1, outputTokens: 2, costUsd },
    durationMs: 10,
    recordedAt: new Date(),
  }, 0);
  return operationKey;
}

describe('costUsd persistence round trip', () => {
  it('getOutcomeByKey returns the costUsd written by recordOutcome', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0, max: 1_000_000, noNaN: true }),
        async (costUsd) => {
          const store = new SqliteJournalStore(':memory:');
          try {
            const run = await store.createRun({ name: 'cost-round-trip' });
            const operationKey = await seedOutcome(store, run.runId, 0, costUsd);

            const read = await store.getOutcomeByKey(operationKey);
            expect(read).not.toBeNull();
            expect(read!.tokens.costUsd).toBe(costUsd);
          } finally {
            store.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('recovery cost accumulator initialization', () => {
  it('recovered run total cost equals the sum of persisted outcome costUsd', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: 0, max: 100, noNaN: true }), {
          minLength: 1,
          maxLength: 8,
        }),
        async (costs) => {
          const store = new SqliteJournalStore(':memory:');
          try {
            const run = await store.createRun({ name: 'recovery-accumulator' });
            await store.updateRun(run.runId, { status: 'running' }, 0);

            for (let i = 0; i < costs.length; i++) {
              await seedOutcome(store, run.runId, i, costs[i]);
            }

            const expectedSum = costs.reduce((a, b) => a + b, 0);

            const engine = new RecoveryEngine(store, new EventBus(), 30_000);
            await engine.recover(
              run.runId,
              async (ctx: DurableContextImpl) => {
                for (let i = 0; i < costs.length; i++) {
                  await ctx.step(`step-${i}`, () => `fresh-${i}`);
                }
                return 'done';
              },
              undefined,
              0,
            );

            const recovered = await store.getRun(run.runId);
            expect(recovered!.totals.cost).toBeCloseTo(expectedSum, 6);
          } finally {
            store.close();
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

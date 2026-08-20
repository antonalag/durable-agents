import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { RecoveryEngine } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { DurableContextImpl } from '../../src/runtime/context.js';
import type { StepStatus } from '../../src/core/types.js';

describe('Property 1: Replay cursor captures all persisted outcomes', () => {
  it('cursor contains exactly N entries for N persisted outcomes regardless of step status', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            status: fc.constantFrom('completed', 'running', 'failed') as fc.Arbitrary<StepStatus>,
            hasOutcome: fc.boolean(),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (stepSpecs) => {
          const store = new SqliteJournalStore(':memory:');
          try {
            const run = await store.createRun({ name: 'cursor-prop-test' });
            await store.updateRun(run.runId, { status: 'running' });

            let expectedOutcomeCount = 0;

            for (let i = 0; i < stepSpecs.length; i++) {
              const spec = stepSpecs[i];
              const stepId = randomUUID();
              await store.createStep({
                stepId,
                runId: run.runId,
                nodeName: `step-${i}`,
                sequence: i,
                status: spec.status,
                startedAt: new Date(),
                cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
                attempt: 1,
              });

              if (spec.hasOutcome) {
                const opKey = computeOperationKey(run.runId, `step-${i}`, i);
                await store.recordOutcome({
                  outcomeId: randomUUID(),
                  stepId,
                  operationType: 'custom',
                  operationKey: opKey,
                  result: `result-${i}`,
                  tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
                  durationMs: 10,
                  recordedAt: new Date(),
                });
                expectedOutcomeCount++;
              }
            }

            let freshExecutions = 0;
            const totalSteps = stepSpecs.length;

            const engine = new RecoveryEngine(store, new EventBus(), 30_000);
            await engine.recover(
              run.runId,
              async (ctx: DurableContextImpl) => {
                for (let i = 0; i < totalSteps; i++) {
                  await ctx.step(`step-${i}`, () => {
                    freshExecutions++;
                    return `fresh-${i}`;
                  });
                }
                return 'done';
              },
              undefined,
            );

            const replayedCount = totalSteps - freshExecutions;
            expect(replayedCount).toBe(expectedOutcomeCount);
          } finally {
            store.close();
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

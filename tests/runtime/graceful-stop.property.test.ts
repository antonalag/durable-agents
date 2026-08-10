import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';

/**
 * Validates: Requirements 6.1
 */
describe('Property 7: Graceful stop allows exactly one more step', () => {
  it('exactly 1 summary step executes after budget exceeded regardless of remaining steps', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 3, max: 15 }),
        async (totalSteps) => {
          const store = new SqliteJournalStore(':memory:');
          const eventBus = new EventBus();
          let stepsExecuted = 0;

          const workflow = new DurableWorkflow(
            'prop7-test',
            async (ctx) => {
              for (let i = 0; i < totalSteps; i++) {
                await ctx.step(`step-${i}`, () => {
                  stepsExecuted++;
                  return `result-${i}`;
                });
              }
              return 'done';
            },
            {
              store,
              eventBus,
              heartbeatIntervalMs: 1000,
              staleTimeoutMs: 5000,
              budget: { maxSteps: 1 },
            },
          );

          await workflow.run(null);

          // step-0: budget check passes (totals.steps=0 < maxSteps=1), executes normally
          // After step-0: totals.steps becomes 1
          // step-1: budget check sees totals.steps=1 >= maxSteps=1 → exceeded → graceful stop
          // step-1 is allowed as the summary step (exactly one more)
          // All remaining steps (step-2..step-N) are blocked
          expect(stepsExecuted).toBe(2);

          store.close();
        },
      ),
      { numRuns: 100 },
    );
  });
});

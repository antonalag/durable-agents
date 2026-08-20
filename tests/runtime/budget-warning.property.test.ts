import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import type { BudgetWarningEvent } from '../../src/core/types.js';

/**
 * WHEN the warning threshold is crossed, THE EventBus SHALL emit
 * `budget:warning` exactly once per limit type per run (no repeated
 * warnings for the same limit).
 */
describe('Property 8: Budget warning emitted at most once per limit type', () => {
  let store: SqliteJournalStore;

  afterEach(() => {
    store?.close();
  });

  it('budget:warning fires at most once per limit type regardless of step count', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 3, max: 12 }),
        fc.integer({ min: 5, max: 20 }),
        async (totalSteps, maxSteps) => {
          fc.pre(totalSteps <= maxSteps);

          store = new SqliteJournalStore(':memory:');
          const eventBus = new EventBus();
          const warnings: BudgetWarningEvent[] = [];

          eventBus.on('budget:warning', (e) => warnings.push(e));

          const workflow = new DurableWorkflow(
            'prop8-test',
            async (ctx) => {
              for (let i = 0; i < totalSteps; i++) {
                await ctx.step(`step-${i}`, () => `result-${i}`);
              }
              return 'done';
            },
            {
              store,
              eventBus,
              heartbeatIntervalMs: 1000,
              staleTimeoutMs: 5000,
              budget: { maxSteps, warningThreshold: 0.1 },
            },
          );

          await workflow.run(null);

          // All warnings in this scenario are triggered by maxSteps.
          // At most 1 warning per limit type.
          expect(warnings.length).toBeLessThanOrEqual(1);

          store.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('budget:warning fires at most once per limit type with multiple budget limits', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 3, max: 10 }),
        fc.integer({ min: 5, max: 15 }),
        fc.double({ min: 5, max: 50, noNaN: true }),
        async (totalSteps, maxSteps, maxCostUsd) => {
          fc.pre(totalSteps <= maxSteps);

          store = new SqliteJournalStore(':memory:');
          const eventBus = new EventBus();
          const warnings: BudgetWarningEvent[] = [];

          eventBus.on('budget:warning', (e) => warnings.push(e));

          const workflow = new DurableWorkflow(
            'prop8-multi',
            async (ctx) => {
              for (let i = 0; i < totalSteps; i++) {
                await ctx.step(`step-${i}`, () => `result-${i}`);
              }
              return 'done';
            },
            {
              store,
              eventBus,
              heartbeatIntervalMs: 1000,
              staleTimeoutMs: 5000,
              budget: { maxSteps, maxCostUsd, warningThreshold: 0.1 },
            },
          );

          await workflow.run(null);

          // Total warnings should be at most the number of distinct limit types (maxSteps + maxCostUsd = 2)
          expect(warnings.length).toBeLessThanOrEqual(2);

          store.close();
        },
      ),
      { numRuns: 100 },
    );
  });
});

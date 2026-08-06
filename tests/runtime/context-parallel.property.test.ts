// Feature: sprint-2-runtime-core, Property 3: Parallel preserves input ordering
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { EventBus } from '../../src/runtime/event-bus.js';

// **Validates: Requirements 3.1, 3.2**
describe('Property 3: Parallel preserves input ordering', () => {
  it('results[i] equals the return value of steps[i].fn() for all i', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { minLength: 1, maxLength: 10 }),
        async (values) => {
          const store = new SqliteJournalStore(':memory:');
          try {
            const run = await store.createRun({ name: 'parallel-order-test' });
            await store.updateRun(run.runId, { status: 'running' });

            const ctx = new DurableContextImpl({
              run,
              store,
              mode: 'fresh',
              replayCursor: new Map(),
              eventBus: new EventBus(),
              signal: new AbortController().signal,
            });

            const steps = values.map((val, i) => ({
              name: `step-${i}`,
              fn: () => val,
            }));

            const results = await ctx.parallel(steps);

            expect(results.length).toBe(values.length);
            for (let i = 0; i < values.length; i++) {
              expect(results[i]).toBe(values[i]);
            }
          } finally {
            store.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

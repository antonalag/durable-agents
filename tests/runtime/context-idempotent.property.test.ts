import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { EventBus } from '../../src/runtime/event-bus.js';

describe('Property 4: Idempotent executes fn at most once per key', () => {
  it('fn is called exactly once regardless of how many times idempotent is invoked with the same key', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 10 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.integer(),
        async (M, operationKey, expectedValue) => {
          const store = new SqliteJournalStore(':memory:');
          const eventBus = new EventBus();

          const run = await store.createRun({ name: 'idempotent-test' });
          await store.updateRun(run.runId, { status: 'running' });

          const controller = new AbortController();
          const ctx = new DurableContextImpl({
            run,
            store,
            mode: 'fresh',
            replayCursor: new Map(),
            eventBus,
            signal: controller.signal,
          });

          let callCount = 0;
          const results: number[] = [];

          for (let i = 0; i < M; i++) {
            const result = await ctx.idempotent(operationKey, () => {
              callCount++;
              return expectedValue;
            });
            results.push(result);
          }

          expect(callCount).toBe(1);
          for (const result of results) {
            expect(result).toBe(expectedValue);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

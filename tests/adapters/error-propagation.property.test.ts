import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { idempotent } from '../../src/adapters/idempotent.js';

/**
 * **Validates: Requirements 3.5, 5.4**
 *
 * Property 6: Error propagation without recording
 * For any wrapped function that throws an error, the adapter propagates the
 * error without recording a successful outcome, allowing retry on next execution.
 */
describe('Property 6: Error propagation without recording', () => {
  it('errors propagate without recording an outcome, allowing retry', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        async (toolName, errorMessage) => {
          const store = new SqliteJournalStore(':memory:');
          const run = await store.createRun({ name: 'error-prop-test' });
          await store.updateRun(run.runId, { status: 'running' });

          const ctx = new DurableContextImpl({
            run,
            store,
            mode: 'fresh',
            replayCursor: new Map(),
            eventBus: new EventBus(),
            signal: new AbortController().signal,
          });

          const error = new Error(errorMessage);
          let threw = false;
          try {
            await idempotent(ctx, toolName, { key: 'val' }, async () => {
              throw error;
            });
          } catch (e) {
            threw = true;
            expect(e).toBe(error);
          }
          expect(threw).toBe(true);

          // Retry with same key should execute fn again (nothing was recorded)
          let retryRan = false;
          const result = await idempotent(ctx, toolName, { key: 'val' }, async () => {
            retryRan = true;
            return 'recovered';
          });

          expect(retryRan).toBe(true);
          expect(result).toBe('recovered');

          store.close();
        },
      ),
      { numRuns: 50 },
    );
  });
});

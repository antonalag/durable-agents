// Feature: sprint-3-framework-adapters, Property 1: Idempotent execution — at most once
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { idempotent } from '../../src/adapters/idempotent.js';

const DANGEROUS_KEYS = new Set(['prototype', '__proto__', 'constructor']);

const safeKey = fc.string({ minLength: 1, maxLength: 20 }).filter((k) => !DANGEROUS_KEYS.has(k));

const safeArgs: fc.Arbitrary<unknown> = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)), { maxLength: 5 }),
  fc.dictionary(safeKey, fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)), {
    maxKeys: 5,
  }),
);

// **Validates: Requirements 5.1, 5.2**
describe('Property 1: Idempotent execution — at most once', () => {
  it('calling idempotent N times with same key invokes fn exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }),
        safeArgs,
        fc.integer({ min: 2, max: 10 }),
        async (toolName, args, callCount) => {
          const store = new SqliteJournalStore(':memory:');
          const run = await store.createRun({ name: 'prop-test' });
          await store.updateRun(run.runId, { status: 'running' });

          const ctx = new DurableContextImpl({
            run,
            store,
            mode: 'fresh',
            replayCursor: new Map(),
            eventBus: new EventBus(),
            signal: new AbortController().signal,
          });

          let invocations = 0;
          const expectedResult = `result-${toolName}`;

          const results: string[] = [];
          for (let i = 0; i < callCount; i++) {
            const r = await idempotent(ctx, toolName, args, async () => {
              invocations++;
              return expectedResult;
            });
            results.push(r);
          }

          expect(invocations).toBe(1);
          expect(results.every((r) => r === expectedResult)).toBe(true);

          store.close();
        },
      ),
      { numRuns: 50 },
    );
  });
});

// Feature: sprint-3-framework-adapters, Property 4: Recovery replays without re-execution
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';

vi.mock('../../src/adapters/peer-check.js', () => ({
  assertPeerDependency: vi.fn(),
}));

const { withDurability } = await import('../../src/adapters/ai-sdk.js');

/**
 * **Validates: Requirements 2.1, 2.2, 2.3, 3.3**
 *
 * Property 4: Recovery replays without re-execution
 * For any sequence of recorded outcomes in a stale run's journal, the recovery
 * path returns each recorded result without invoking the original function.
 */
describe('Property 4: Recovery replays without re-execution', () => {
  it('pre-recorded outcomes are returned without executing fn', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), {
          minLength: 2,
          maxLength: 10,
        }),
        async (stepNames) => {
          const store = new SqliteJournalStore(':memory:');
          const run = await store.createRun({ name: 'recovery-test' });
          await store.updateRun(run.runId, { status: 'running' });

          const eventBus = new EventBus();
          const ctx = new DurableContextImpl({
            run,
            store,
            mode: 'fresh',
            replayCursor: new Map(),
            eventBus,
            signal: new AbortController().signal,
          });

          // Pre-record outcomes for all steps using the same key formula as withDurability
          for (const name of stepNames) {
            const operationKey = computeOperationKey(run.runId, name);
            const stepId = randomUUID();

            await store.createStep({
              stepId,
              runId: run.runId,
              nodeName: name,
              sequence: 0,
              status: 'completed',
              startedAt: new Date(),
              cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
              attempt: 1,
            });

            await store.recordOutcome({
              outcomeId: randomUUID(),
              stepId,
              operationType: 'llm_call',
              operationKey,
              result: { text: `cached-${name}` },
              tokens: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
              durationMs: 50,
              recordedAt: new Date(),
            });
          }

          // Call withDurability for each step — should return cached result, never call fn
          let fnCalls = 0;
          for (const name of stepNames) {
            const result = await withDurability(
              { store, ctx, eventBus },
              name,
              async () => {
                fnCalls++;
                return { text: 'should-not-be-called' };
              },
            );
            expect(result).toEqual({ text: `cached-${name}` });
          }

          expect(fnCalls).toBe(0);
          store.close();
        },
      ),
      { numRuns: 30 },
    );
  });
});

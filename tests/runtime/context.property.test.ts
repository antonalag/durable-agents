// Feature: sprint-2-runtime-core, Property 1: Exactly-once step execution per operationKey
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { EventBus } from '../../src/runtime/event-bus.js';

// Validates: Requirements 2.5, 3.4, 5.4, 8.2
describe('Property 1: Exactly-once step execution per operationKey', () => {
  it('executing N sequential steps produces exactly N unique OutcomeRecords', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 20 }), async (n) => {
        const store = new SqliteJournalStore(':memory:');

        const run = await store.createRun({ name: 'test-wf' });
        await store.updateRun(run.runId, { status: 'running' });

        const ctx = new DurableContextImpl({
          run,
          store,
          mode: 'fresh',
          replayCursor: new Map(),
          eventBus: new EventBus(),
          signal: new AbortController().signal,
        });

        for (let i = 0; i < n; i++) {
          await ctx.step(`step-${i}`, () => i);
        }

        const steps = await store.listSteps(run.runId);
        expect(steps).toHaveLength(n);

        const allOutcomes = [];
        for (const step of steps) {
          const outcomes = await store.listOutcomes(step.stepId);
          allOutcomes.push(...outcomes);
        }

        expect(allOutcomes).toHaveLength(n);

        const operationKeys = allOutcomes.map((o) => o.operationKey);
        const uniqueKeys = new Set(operationKeys);
        expect(uniqueKeys.size).toBe(n);

        store.close();
      }),
      { numRuns: 100 },
    );
  });
});

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { RecoveryEngine } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import type { WorkflowFn } from '../../src/runtime/workflow.js';

describe('Property 7: Recovery produces identical result to uninterrupted execution', () => {
  it('recovered workflow produces the same result as an uninterrupted run', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { minLength: 2, maxLength: 20 }),
        fc.integer({ min: 1, max: 19 }),
        async (stepValues, rawK) => {
          const L = stepValues.length;
          const K = Math.min(rawK, L - 1);

          const store = new SqliteJournalStore(':memory:');

          const workflowFn: WorkflowFn<null, number[]> = async (ctx) => {
            const results: number[] = [];
            for (let i = 0; i < L; i++) {
              const r = await ctx.step(`step-${i}`, () => stepValues[i]);
              results.push(r);
            }
            return results;
          };

          // Clean run
          const cleanRun = await store.createRun({ name: 'clean-wf' });
          await store.updateRun(cleanRun.runId, { status: 'running' });

          const cleanCtx = new DurableContextImpl({
            run: cleanRun,
            store,
            mode: 'fresh',
            replayCursor: new Map(),
            eventBus: new EventBus(),
            signal: new AbortController().signal,
          });

          const cleanResult = await workflowFn(cleanCtx, null);

          // Set up a second run that "crashed" after K steps
          const recoveryRun = await store.createRun({ name: 'recovery-wf' });
          await store.updateRun(recoveryRun.runId, { status: 'running' });

          const setupCtx = new DurableContextImpl({
            run: recoveryRun,
            store,
            mode: 'fresh',
            replayCursor: new Map(),
            eventBus: new EventBus(),
            signal: new AbortController().signal,
          });

          // Execute only the first K steps to simulate partial completion before crash
          for (let i = 0; i < K; i++) {
            await setupCtx.step(`step-${i}`, () => stepValues[i]);
          }

          // Recover the run
          const engine = new RecoveryEngine(store, new EventBus(), 30_000);
          const recoveredResult = await engine.recover(recoveryRun.runId, workflowFn, null);

          expect(recoveredResult).toEqual(cleanResult);

          store.close();
        },
      ),
      { numRuns: 50 },
    );
  });
});

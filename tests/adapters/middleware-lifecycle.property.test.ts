// Feature: sprint-3-framework-adapters, Property 5: Middleware lifecycle invariant
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import type { RunConfig, Step } from '../../src/core/types.js';

vi.mock('../../src/adapters/peer-check.js', () => ({
  assertPeerDependency: vi.fn(),
}));

const { createDurableMiddleware } = await import('../../src/adapters/langgraph.js');

// **Validates: Requirements 1.2, 1.4, 2.4**
describe('Property 5: Middleware lifecycle invariant', () => {
  it('run transitions through running → completed with correct events', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.array(
          fc.record({
            inputTokens: fc.nat({ max: 10_000 }),
            outputTokens: fc.nat({ max: 10_000 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (stepCount, tokenSets) => {
          const tokens = tokenSets.slice(0, stepCount);
          const store = new SqliteJournalStore(':memory:');
          const eventBus = new EventBus();
          const config: RunConfig = {
            name: 'lifecycle-test',
            heartbeatIntervalMs: 60_000,
            staleTimeoutMs: 120_000,
          };

          const events: string[] = [];
          eventBus.on('run:started', () => events.push('run:started'));
          eventBus.on('run:completed', () => events.push('run:completed'));

          const mw = createDurableMiddleware({ store, config, eventBus });

          await mw.beforeAgent!({ runId: '', config });

          const runs = await store.listRuns();
          const run = runs[0];
          expect(run.status).toBe('running');

          for (let i = 0; i < tokens.length; i++) {
            const step: Step = {
              stepId: `step-${i}`,
              runId: run.runId,
              nodeName: `model-call-${i}`,
              sequence: i,
              status: 'completed',
              startedAt: new Date(),
              cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
              attempt: 1,
            };
            await store.createStep(step);

            await mw.afterModel!({
              runId: run.runId,
              step,
              response: {
                usage_metadata: {
                  input_tokens: tokens[i].inputTokens,
                  output_tokens: tokens[i].outputTokens,
                },
              },
            });
          }

          await mw.afterAgent!({
            runId: run.runId,
            result: 'final',
            totals: run.totals,
          });

          const finalRun = await store.getRun(run.runId);
          expect(finalRun!.status).toBe('completed');
          expect(events).toEqual(['run:started', 'run:completed']);

          store.close();
        },
      ),
      { numRuns: 30 },
    );
  });
});

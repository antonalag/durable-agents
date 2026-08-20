import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { RecoveryEngine } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type { ExecutionRun, Step, OutcomeRecord } from '../../src/core/types.js';
import type { DurableContextImpl } from '../../src/runtime/context.js';

describe('Property 2: Recovery replays K cached results and executes (L-K) remaining', () => {
  it('replays K cached results and freshly executes (L-K) remaining steps', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 1, max: 19 }),
        async (L, rawK) => {
          const K = Math.min(rawK, L - 1);
          let freshExecutions = 0;

          const runId = 'run-recovery-test';

          const run: ExecutionRun = {
            runId,
            status: 'running',
            config: {
              name: 'test-workflow',
              heartbeatIntervalMs: 10_000,
              staleTimeoutMs: 30_000,
            },
            metadata: {},
            totals: { cost: 0, tokens: 0, steps: K, recoveryCount: 0 },
            createdAt: new Date(),
            updatedAt: new Date(),
            lastHeartbeat: new Date(),
          };

          const completedSteps: Step[] = [];
          const outcomesByStepId = new Map<string, OutcomeRecord[]>();

          for (let i = 0; i < K; i++) {
            const stepId = `step-id-${i}`;
            const operationKey = computeOperationKey(runId, `step-${i}`, i);

            completedSteps.push({
              stepId,
              runId,
              nodeName: `step-${i}`,
              sequence: i,
              status: 'completed',
              startedAt: new Date(),
              completedAt: new Date(),
              cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
              attempt: 1,
            });

            outcomesByStepId.set(stepId, [
              {
                outcomeId: `outcome-${i}`,
                stepId,
                operationType: 'custom',
                operationKey,
                result: `result-${i}`,
                tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
                durationMs: 1,
                recordedAt: new Date(),
              },
            ]);
          }

          const store: JournalStore = {
            getRun: vi.fn().mockResolvedValue(run),
            listSteps: vi.fn().mockResolvedValue(completedSteps),
            listOutcomes: vi.fn().mockImplementation((stepId: string) => {
              return Promise.resolve(outcomesByStepId.get(stepId) ?? []);
            }),
            createStep: vi.fn().mockImplementation((step: Omit<Step, 'completedAt'>) => {
              return Promise.resolve({ ...step, completedAt: undefined });
            }),
            updateStep: vi.fn().mockResolvedValue({}),
            recordOutcome: vi.fn().mockImplementation((outcome: OutcomeRecord) => {
              return Promise.resolve(outcome);
            }),
            updateRun: vi.fn().mockResolvedValue(run),
            updateHeartbeat: vi.fn().mockResolvedValue(undefined),
            getOutcomeByKey: vi.fn().mockResolvedValue(null),
            createRun: vi.fn(),
            getStep: vi.fn(),
            getOutcome: vi.fn(),
            listRuns: vi.fn(),
            deleteRun: vi.fn(),
            findStaleRuns: vi.fn(),
            deleteRunsOlderThan: vi.fn(),
          } as unknown as JournalStore;

          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const workflowFn = async (ctx: DurableContextImpl, _input: unknown) => {
            for (let i = 0; i < L; i++) {
              await ctx.step(`step-${i}`, () => {
                freshExecutions++;
                return `result-${i}`;
              });
            }
            return 'done';
          };

          const engine = new RecoveryEngine(store, new EventBus(), 30_000);
          await engine.recover(runId, workflowFn, null);

          expect(freshExecutions).toBe(L - K);
        },
      ),
      { numRuns: 50 },
    );
  });
});

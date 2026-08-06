import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecoveryEngine } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type {
  ExecutionRun,
  RunRecoveredEvent,
  RunFailedEvent,
  Step,
  OutcomeRecord,
} from '../../src/core/types.js';
import type { DurableContextImpl } from '../../src/runtime/context.js';

function createRecoveryMockStore(opts: {
  runId: string;
  completedStepCount: number;
  recoveryCount?: number;
}) {
  const now = new Date();
  const run: ExecutionRun = {
    runId: opts.runId,
    status: 'running',
    config: { name: 'test-workflow', heartbeatIntervalMs: 10000, staleTimeoutMs: 30000 },
    metadata: {},
    totals: { cost: 0, tokens: 0, steps: opts.completedStepCount, recoveryCount: opts.recoveryCount ?? 0 },
    createdAt: now,
    updatedAt: now,
    lastHeartbeat: now,
  };

  const completedSteps: Step[] = Array.from({ length: opts.completedStepCount }, (_, i) => ({
    stepId: `step-${i}`,
    runId: opts.runId,
    nodeName: `step-${i}`,
    sequence: i,
    status: 'completed' as const,
    startedAt: now,
    completedAt: now,
    cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    attempt: 1,
  }));

  const outcomesByStep = new Map<string, OutcomeRecord[]>();
  for (const step of completedSteps) {
    const opKey = computeOperationKey(opts.runId, step.nodeName, step.sequence);
    outcomesByStep.set(step.stepId, [{
      outcomeId: `outcome-${step.sequence}`,
      stepId: step.stepId,
      operationType: 'custom',
      operationKey: opKey,
      result: `result-${step.sequence}`,
      tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      durationMs: 10,
      recordedAt: now,
    }]);
  }

  return {
    getRun: vi.fn().mockResolvedValue(run),
    listSteps: vi.fn().mockResolvedValue(completedSteps),
    listOutcomes: vi.fn().mockImplementation((stepId: string) =>
      Promise.resolve(outcomesByStep.get(stepId) ?? []),
    ),
    updateRun: vi.fn().mockResolvedValue({ ...run, status: 'completed' }),
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    createStep: vi.fn().mockImplementation((step) => Promise.resolve({ ...step, completedAt: undefined })),
    updateStep: vi.fn().mockImplementation((stepId, updates) => Promise.resolve({ stepId, ...updates })),
    recordOutcome: vi.fn().mockImplementation((outcome) => Promise.resolve(outcome)),
    getOutcomeByKey: vi.fn().mockResolvedValue(null),
    findStaleRuns: vi.fn().mockResolvedValue([]),
    createRun: vi.fn().mockResolvedValue(run),
    getStep: vi.fn().mockResolvedValue(null),
    getOutcome: vi.fn().mockResolvedValue(null),
    listRuns: vi.fn().mockResolvedValue([]),
    deleteRun: vi.fn().mockResolvedValue(undefined),
    deleteRunsOlderThan: vi.fn().mockResolvedValue(0),
  };
}

describe('RecoveryEngine', () => {
  const staleTimeoutMs = 30_000;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  describe('detectStaleRuns', () => {
    it('delegates to store.findStaleRuns with the configured timeout and returns matching runs', async () => {
      const now = new Date();
      const staleRuns: ExecutionRun[] = [
        {
          runId: 'stale-1',
          status: 'running',
          config: { name: 'wf-a' },
          metadata: {},
          totals: { cost: 0, tokens: 0, steps: 3, recoveryCount: 0 },
          createdAt: now,
          updatedAt: now,
          lastHeartbeat: new Date(now.getTime() - 60_000),
        },
        {
          runId: 'stale-2',
          status: 'running',
          config: { name: 'wf-b' },
          metadata: {},
          totals: { cost: 0, tokens: 0, steps: 1, recoveryCount: 1 },
          createdAt: now,
          updatedAt: now,
          lastHeartbeat: new Date(now.getTime() - 45_000),
        },
      ];

      const store = createRecoveryMockStore({ runId: 'unused', completedStepCount: 0 });
      store.findStaleRuns.mockResolvedValue(staleRuns);

      const engine = new RecoveryEngine(store as unknown as JournalStore, eventBus, staleTimeoutMs);
      const result = await engine.detectStaleRuns();

      expect(store.findStaleRuns).toHaveBeenCalledWith(staleTimeoutMs);
      expect(result).toEqual(staleRuns);
      expect(result).toHaveLength(2);
    });
  });

  describe('recover', () => {
    it('emits run:recovered event with correct metadata', async () => {
      const runId = 'run-recover-1';
      const store = createRecoveryMockStore({ runId, completedStepCount: 2 });

      const engine = new RecoveryEngine(store as unknown as JournalStore, eventBus, staleTimeoutMs);

      const events: RunRecoveredEvent[] = [];
      eventBus.on('run:recovered', (e) => events.push(e));

      // Workflow with 3 steps total; first 2 replay from cache, 3rd executes fresh
      const workflowFn = async (ctx: DurableContextImpl) => {
        await ctx.step('step-0', () => 'result-0');
        await ctx.step('step-1', () => 'result-1');
        await ctx.step('step-2', () => 'result-2');
        return 'done';
      };

      const result = await engine.recover(runId, workflowFn, 'test-input');

      expect(result).toBe('done');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('run:recovered');
      expect(events[0].runId).toBe(runId);
      expect(events[0].recoveredFromStep).toBe(2);
      expect(events[0].totalStepsRecovered).toBe(2);
    });

    it('increments recoveryCount in updateRun', async () => {
      const runId = 'run-recover-count';
      const store = createRecoveryMockStore({ runId, completedStepCount: 1, recoveryCount: 2 });

      const engine = new RecoveryEngine(store as unknown as JournalStore, eventBus, staleTimeoutMs);

      const workflowFn = async (ctx: DurableContextImpl) => {
        await ctx.step('step-0', () => 'cached');
        return 'ok';
      };

      await engine.recover(runId, workflowFn, 'input');

      expect(store.updateRun).toHaveBeenCalledWith(runId, expect.objectContaining({
        status: 'completed',
        totals: expect.objectContaining({ recoveryCount: 3 }),
      }));
    });

    it('marks run as failed and emits run:failed when workflow throws', async () => {
      const runId = 'run-recover-fail';
      const store = createRecoveryMockStore({ runId, completedStepCount: 0 });

      const engine = new RecoveryEngine(store as unknown as JournalStore, eventBus, staleTimeoutMs);

      const failedEvents: RunFailedEvent[] = [];
      eventBus.on('run:failed', (e) => failedEvents.push(e));

      const workflowFn = async (): Promise<string> => {
        throw new Error('recovery exploded');
      };

      await expect(engine.recover(runId, workflowFn, 'input')).rejects.toThrow('recovery exploded');

      expect(store.updateRun).toHaveBeenCalledWith(runId, { status: 'failed' });
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].type).toBe('run:failed');
      expect(failedEvents[0].runId).toBe(runId);
      expect(failedEvents[0].error.message).toBe('recovery exploded');
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecoveryEngine } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type {
  ExecutionRun,
  Step,
  OutcomeRecord,
} from '../../src/core/types.js';
import type { DurableContextImpl } from '../../src/runtime/context.js';

function createMockStore(opts: {
  runId: string;
  steps: Array<{ status: 'running' | 'completed' | 'failed'; hasOutcome: boolean }>;
}) {
  const now = new Date();
  const run: ExecutionRun = {
    runId: opts.runId,
    status: 'running',
    config: { name: 'test-workflow', heartbeatIntervalMs: 10000, staleTimeoutMs: 30000 },
    metadata: {},
    totals: { cost: 0, tokens: 0, steps: opts.steps.length, recoveryCount: 0 },
    createdAt: now,
    updatedAt: now,
    lastHeartbeat: now,
  };

  const steps: Step[] = opts.steps.map((s, i) => ({
    stepId: `step-${i}`,
    runId: opts.runId,
    nodeName: `step-${i}`,
    sequence: i,
    status: s.status,
    startedAt: now,
    completedAt: s.status === 'completed' ? now : undefined,
    cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    attempt: 1,
  }));

  const outcomesByStep = new Map<string, OutcomeRecord[]>();
  for (let i = 0; i < opts.steps.length; i++) {
    const s = opts.steps[i];
    if (s.hasOutcome) {
      const opKey = computeOperationKey(opts.runId, `step-${i}`, i);
      outcomesByStep.set(`step-${i}`, [{
        outcomeId: `outcome-${i}`,
        stepId: `step-${i}`,
        operationType: 'custom',
        operationKey: opKey,
        result: `result-${i}`,
        tokens: { inputTokens: 10, outputTokens: 20, costUsd: 0.001 },
        durationMs: 50,
        recordedAt: now,
      }]);
    } else {
      outcomesByStep.set(`step-${i}`, []);
    }
  }

  return {
    getRun: vi.fn().mockResolvedValue(run),
    listSteps: vi.fn().mockResolvedValue(steps),
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

describe('RecoveryEngine — cursor fix for running-step outcomes', () => {
  const staleTimeoutMs = 30_000;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  it('builds cursor from step with status running that has a persisted outcome — fn() is NOT called', async () => {
    const runId = 'run-running-outcome';
    const store = createMockStore({
      runId,
      steps: [
        { status: 'running', hasOutcome: true },
      ],
    });

    const engine = new RecoveryEngine(store as unknown as JournalStore, eventBus, staleTimeoutMs);

    const stepFn = vi.fn(() => 'fresh-result');
    const workflowFn = async (ctx: DurableContextImpl) => {
      const r = await ctx.step('step-0', stepFn);
      return r;
    };

    const result = await engine.recover(runId, workflowFn, undefined);

    expect(result).toBe('result-0');
    expect(stepFn).not.toHaveBeenCalled();
  });

  it('heals running steps to completed after successful replay', async () => {
    const runId = 'run-heal-step';
    const store = createMockStore({
      runId,
      steps: [
        { status: 'running', hasOutcome: true },
        { status: 'completed', hasOutcome: true },
      ],
    });

    const engine = new RecoveryEngine(store as unknown as JournalStore, eventBus, staleTimeoutMs);

    const workflowFn = async (ctx: DurableContextImpl) => {
      await ctx.step('step-0', () => 'cached-0');
      await ctx.step('step-1', () => 'cached-1');
      return 'done';
    };

    await engine.recover(runId, workflowFn, undefined);

    expect(store.updateStep).toHaveBeenCalledWith('step-0', expect.objectContaining({
      status: 'completed',
      completedAt: expect.any(Date),
    }));
  });

  it('excludes running steps with NO outcome from cursor — fn() IS called', async () => {
    const runId = 'run-no-outcome';
    const store = createMockStore({
      runId,
      steps: [
        { status: 'running', hasOutcome: false },
      ],
    });

    const engine = new RecoveryEngine(store as unknown as JournalStore, eventBus, staleTimeoutMs);

    const stepFn = vi.fn(() => 'fresh-result');
    const workflowFn = async (ctx: DurableContextImpl) => {
      const r = await ctx.step('step-0', stepFn);
      return r;
    };

    const result = await engine.recover(runId, workflowFn, undefined);

    expect(result).toBe('fresh-result');
    expect(stepFn).toHaveBeenCalledTimes(1);
  });

  it('does not call recordOutcome for replayed steps — unique constraint never violated', async () => {
    const runId = 'run-no-duplicate';
    const store = createMockStore({
      runId,
      steps: [
        { status: 'running', hasOutcome: true },
        { status: 'completed', hasOutcome: true },
      ],
    });

    const engine = new RecoveryEngine(store as unknown as JournalStore, eventBus, staleTimeoutMs);

    const workflowFn = async (ctx: DurableContextImpl) => {
      await ctx.step('step-0', () => 'x');
      await ctx.step('step-1', () => 'y');
      return 'ok';
    };

    await engine.recover(runId, workflowFn, undefined);

    expect(store.recordOutcome).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type {
  ExecutionRun,
  RunStartedEvent,
  RunCompletedEvent,
} from '../../src/core/types.js';

function createMockStore() {
  const now = new Date();
  const fakeRun: ExecutionRun = {
    runId: 'hook-run-1',
    status: 'running',
    config: { name: 'hook-test' },
    metadata: {},
    totals: { cost: 0, tokens: 0, steps: 0, recoveryCount: 0 },
    createdAt: now,
    updatedAt: now,
    lastHeartbeat: now,
  };

  return {
    createRun: vi.fn().mockResolvedValue(fakeRun),
    updateRun: vi.fn().mockResolvedValue({ ...fakeRun, status: 'completed' }),
    getRun: vi.fn().mockResolvedValue(fakeRun),
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    createStep: vi.fn().mockResolvedValue({
      stepId: 'step-1',
      runId: 'hook-run-1',
      nodeName: 'test',
      sequence: 0,
      status: 'running',
      startedAt: now,
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      attempt: 1,
    }),
    updateStep: vi.fn().mockResolvedValue({
      stepId: 'step-1',
      runId: 'hook-run-1',
      nodeName: 'test',
      sequence: 0,
      status: 'completed',
      startedAt: now,
      completedAt: now,
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      attempt: 1,
    }),
    recordOutcome: vi.fn().mockResolvedValue({
      outcomeId: 'outcome-1',
      stepId: 'step-1',
      operationType: 'custom',
      operationKey: 'key-1',
      result: null,
      tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      durationMs: 0,
      recordedAt: now,
    }),
    getOutcomeByKey: vi.fn().mockResolvedValue(null),
    getStep: vi.fn().mockResolvedValue(null),
    getOutcome: vi.fn().mockResolvedValue(null),
    listSteps: vi.fn().mockResolvedValue([]),
    listOutcomes: vi.fn().mockResolvedValue([]),
    listRuns: vi.fn().mockResolvedValue([]),
    findStaleRuns: vi.fn().mockResolvedValue([]),
    deleteRun: vi.fn().mockResolvedValue(undefined),
    deleteRunsOlderThan: vi.fn().mockResolvedValue(0),
  } as unknown as JournalStore;
}

describe('Event Hooks API (.on / .off on DurableWorkflow)', () => {
  it('handler registered with .on() is invoked on event emission', async () => {
    const store = createMockStore();
    const events: RunStartedEvent[] = [];

    const workflow = new DurableWorkflow('hook-test', async (ctx) => {
      await ctx.step('s1', () => 'done');
      return 'ok';
    }, { store, heartbeatIntervalMs: 1000, staleTimeoutMs: 5000 });

    workflow.on('run:started', (e) => events.push(e));
    await workflow.run(null);

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('run:started');
    expect(events[0].runId).toBe('hook-run-1');
  });

  it('handler removed with .off() is NOT invoked', async () => {
    const store = createMockStore();
    const events: RunCompletedEvent[] = [];
    const handler = (e: RunCompletedEvent) => events.push(e);

    const workflow = new DurableWorkflow('hook-test', async (ctx) => {
      await ctx.step('s1', () => 'done');
      return 'ok';
    }, { store, heartbeatIntervalMs: 1000, staleTimeoutMs: 5000 });

    workflow.on('run:completed', handler);
    workflow.off('run:completed', handler);
    await workflow.run(null);

    expect(events.length).toBe(0);
  });

  it('multiple handlers for same event type all receive the event', async () => {
    const store = createMockStore();
    let count = 0;

    const workflow = new DurableWorkflow('hook-test', async (ctx) => {
      await ctx.step('s1', () => 'done');
      return 'ok';
    }, { store, heartbeatIntervalMs: 1000, staleTimeoutMs: 5000 });

    workflow.on('run:started', () => count++);
    workflow.on('run:started', () => count++);
    workflow.on('run:started', () => count++);
    await workflow.run(null);

    expect(count).toBe(3);
  });

  it('.on() supports different event types independently', async () => {
    const store = createMockStore();
    const started: RunStartedEvent[] = [];
    const completed: RunCompletedEvent[] = [];

    const workflow = new DurableWorkflow('hook-test', async (ctx) => {
      await ctx.step('s1', () => 'done');
      return 'ok';
    }, { store, heartbeatIntervalMs: 1000, staleTimeoutMs: 5000 });

    workflow.on('run:started', (e) => started.push(e));
    workflow.on('run:completed', (e) => completed.push(e));
    await workflow.run(null);

    expect(started.length).toBe(1);
    expect(completed.length).toBe(1);
    expect(started[0].type).toBe('run:started');
    expect(completed[0].type).toBe('run:completed');
  });
});

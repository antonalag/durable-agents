import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type {
  ExecutionRun,
  RunStartedEvent,
  RunCompletedEvent,
  RunFailedEvent,
} from '../../src/core/types.js';

function createMockStore() {
  const now = new Date();
  const fakeRun: ExecutionRun = {
    runId: 'run-123',
    status: 'running',
    config: { name: 'test-workflow' },
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
      runId: 'run-123',
      nodeName: 'test',
      sequence: 0,
      status: 'running',
      startedAt: now,
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      attempt: 1,
    }),
    updateStep: vi.fn().mockResolvedValue({
      stepId: 'step-1',
      runId: 'run-123',
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
  };
}

describe('DurableWorkflow', () => {
  let store: ReturnType<typeof createMockStore>;
  let eventBus: EventBus;

  beforeEach(() => {
    store = createMockStore();
    eventBus = new EventBus();
  });

  describe('.run() success path', () => {
    it('creates run record and returns result on success', async () => {
      const workflow = new DurableWorkflow('test-workflow', async (_ctx, input: string) => {
        return `result:${input}`;
      }, { store: store as unknown as JournalStore, eventBus });

      const result = await workflow.run('hello');

      expect(store.createRun).toHaveBeenCalledTimes(1);
      expect(store.updateRun).toHaveBeenCalledWith('run-123', expect.objectContaining({
        status: 'completed',
      }));
      expect(result).toBe('result:hello');
    });
  });

  describe('.run() failure path', () => {
    it('sets status=failed on error and propagates', async () => {
      const error = new Error('workflow exploded');
      const workflow = new DurableWorkflow('test-workflow', async () => {
        throw error;
      }, { store: store as unknown as JournalStore, eventBus });

      await expect(workflow.run('input')).rejects.toThrow('workflow exploded');
      expect(store.updateRun).toHaveBeenCalledWith('run-123', expect.objectContaining({
        status: 'failed',
      }));
    });
  });

  describe('heartbeat lifecycle', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('starts on run and stops on completion', async () => {
      const workflow = new DurableWorkflow('test-workflow', async (_ctx, input: string) => {
        return input;
      }, { store: store as unknown as JournalStore, eventBus, heartbeatIntervalMs: 5000, staleTimeoutMs: 30000 });

      const runPromise = workflow.run('data');

      // Need to flush microtasks so the async run proceeds with fake timers
      await vi.runAllTimersAsync();
      const result = await runPromise;
      expect(result).toBe('data');

      // Heartbeat fires immediately on start
      expect(store.updateHeartbeat).toHaveBeenCalledWith('run-123');

      const callCount = store.updateHeartbeat.mock.calls.length;

      // After completion, advancing time should not produce more heartbeat calls
      await vi.advanceTimersByTimeAsync(15000);
      expect(store.updateHeartbeat).toHaveBeenCalledTimes(callCount);
    });
  });

  describe('AbortSignal handling', () => {
    it('stops execution, leaves run as running', async () => {
      const controller = new AbortController();
      controller.abort();

      const workflow = new DurableWorkflow('test-workflow', async (ctx) => {
        if (ctx.signal.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        return 'done';
      }, { store: store as unknown as JournalStore, eventBus });

      await workflow.run('input', { signal: controller.signal });

      // Run should NOT be marked as failed — AbortError leaves it as running
      const failedCall = store.updateRun.mock.calls.find(
        (call) => call[1]?.status === 'failed',
      );
      expect(failedCall).toBeUndefined();
    });
  });

  describe('constructor validation', () => {
    it('rejects heartbeatIntervalMs >= staleTimeoutMs (equal)', () => {
      expect(() => {
        new DurableWorkflow('test', async () => 'x', {
          store: store as unknown as JournalStore,
          heartbeatIntervalMs: 10000,
          staleTimeoutMs: 10000,
        });
      }).toThrow();
    });

    it('rejects heartbeatIntervalMs >= staleTimeoutMs (greater)', () => {
      expect(() => {
        new DurableWorkflow('test', async () => 'x', {
          store: store as unknown as JournalStore,
          heartbeatIntervalMs: 50000,
          staleTimeoutMs: 30000,
        });
      }).toThrow();
    });
  });

  describe('event emission', () => {
    it('emits run:started event on workflow start', async () => {
      const events: RunStartedEvent[] = [];
      eventBus.on('run:started', (e) => events.push(e));

      const workflow = new DurableWorkflow('test-workflow', async () => 'done', {
        store: store as unknown as JournalStore,
        eventBus,
      });

      await workflow.run('input');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('run:started');
      expect(events[0].runId).toBe('run-123');
      expect(events[0].config.name).toBe('test-workflow');
    });

    it('emits run:completed event on success', async () => {
      const events: RunCompletedEvent[] = [];
      eventBus.on('run:completed', (e) => events.push(e));

      const workflow = new DurableWorkflow('test-workflow', async () => 'result-value', {
        store: store as unknown as JournalStore,
        eventBus,
      });

      await workflow.run('input');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('run:completed');
      expect(events[0].runId).toBe('run-123');
      expect(events[0].result).toBe('result-value');
    });

    it('emits run:failed event on error', async () => {
      const events: RunFailedEvent[] = [];
      eventBus.on('run:failed', (e) => events.push(e));

      const error = new Error('kaboom');
      const workflow = new DurableWorkflow('test-workflow', async () => {
        throw error;
      }, { store: store as unknown as JournalStore, eventBus });

      await expect(workflow.run('input')).rejects.toThrow('kaboom');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('run:failed');
      expect(events[0].runId).toBe('run-123');
      expect(events[0].error.message).toBe('kaboom');
    });
  });
});

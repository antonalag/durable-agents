import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type { ExecutionRun, EventMap } from '../../src/core/types.js';

const eventTypes: Array<keyof EventMap> = [
  'run:started', 'run:completed', 'run:failed', 'run:recovered',
  'step:started', 'step:completed',
  'budget:warning', 'budget:exceeded', 'loop:detected',
];

function createMockStore(): JournalStore {
  const now = new Date();
  const fakeRun: ExecutionRun = {
    runId: 'hook-run', status: 'running', config: { name: 'test' }, metadata: {},
    totals: { cost: 0, tokens: 0, steps: 0, recoveryCount: 0 },
    createdAt: now, updatedAt: now, lastHeartbeat: now,
  };
  return {
    createRun: vi.fn().mockResolvedValue(fakeRun),
    updateRun: vi.fn().mockResolvedValue(fakeRun),
    getRun: vi.fn().mockResolvedValue(fakeRun),
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    createStep: vi.fn().mockResolvedValue({ stepId: 's1', runId: 'hook-run', nodeName: 'x', sequence: 0, status: 'running', startedAt: now, cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, attempt: 1 }),
    updateStep: vi.fn().mockResolvedValue({}),
    recordOutcome: vi.fn().mockResolvedValue({}),
    getOutcomeByKey: vi.fn().mockResolvedValue(null),
    getStep: vi.fn(), getOutcome: vi.fn(), listSteps: vi.fn().mockResolvedValue([]),
    listOutcomes: vi.fn().mockResolvedValue([]), listRuns: vi.fn().mockResolvedValue([]),
    findStaleRuns: vi.fn().mockResolvedValue([]),
    deleteRun: vi.fn(), deleteRunsOlderThan: vi.fn(),
  } as unknown as JournalStore;
}

/**
 * Property 10: Event hook delegation round-trip
 * Validates: Requirements 8.1, 8.2
 */
describe('Property 10: Event hook delegation round-trip', () => {
  it('.on() registers and .off() removes handlers correctly', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...eventTypes),
        (eventType) => {
          const eventBus = new EventBus();
          const store = createMockStore();
          const workflow = new DurableWorkflow('test', async (ctx) => {
            await ctx.step('s', () => 'ok');
            return 'done';
          }, { store, eventBus, heartbeatIntervalMs: 1000, staleTimeoutMs: 5000 });

          let called = 0;
          const handler = () => { called++; };

          workflow.on(eventType, handler);
          eventBus.emit(eventType, { type: eventType, timestamp: new Date(), runId: 'test' } as EventMap[typeof eventType]);
          expect(called).toBe(1);

          workflow.off(eventType, handler);
          eventBus.emit(eventType, { type: eventType, timestamp: new Date(), runId: 'test' } as EventMap[typeof eventType]);
          expect(called).toBe(1);
        },
      ),
      { numRuns: 50 },
    );
  });
});

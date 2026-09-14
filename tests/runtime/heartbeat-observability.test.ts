import { describe, it, expect, vi } from 'vitest';
import { Heartbeat } from '../../src/runtime/heartbeat.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type { HeartbeatFailedEvent } from '../../src/core/types.js';

describe('heartbeat failure observability', () => {
  it('emits heartbeat:failed instead of throwing when the write rejects', async () => {
    const eventBus = new EventBus();
    const failures: HeartbeatFailedEvent[] = [];
    eventBus.on('heartbeat:failed', (e) => failures.push(e));

    const store = {
      updateHeartbeat: vi
        .fn()
        .mockRejectedValue(new Error('store unavailable')),
    } as unknown as JournalStore;

    const heartbeat = new Heartbeat(store, 'run-1', 10_000, 0, eventBus);
    heartbeat.start();

    await new Promise((resolve) => setTimeout(resolve, 10));
    heartbeat.stop();

    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures[0].runId).toBe('run-1');
    expect(failures[0].error).toBeInstanceOf(Error);
    expect(failures[0].error.message).toBe('store unavailable');
  });

  it('does not crash a running workflow when the heartbeat write fails', async () => {
    const inner = new SqliteJournalStore(':memory:');
    try {
      const eventBus = new EventBus();
      const failures: HeartbeatFailedEvent[] = [];
      eventBus.on('heartbeat:failed', (e) => failures.push(e));

      // Wrap the real store so heartbeat writes fail but everything else works.
      const store = new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === 'updateHeartbeat') {
            return () => Promise.reject(new Error('heartbeat down'));
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as JournalStore;

      const workflow = new DurableWorkflow(
        'heartbeat-resilient',
        async (ctx) => {
          await ctx.step('a', () => 'x');
          await ctx.step('b', () => 'y');
          return 'done';
        },
        { store, eventBus, heartbeatIntervalMs: 1 },
      );

      const result = await workflow.run('input');
      expect(result).toBe('done');

      const runs = await inner.listRuns();
      expect(runs[0].status).toBe('completed');
    } finally {
      inner.close();
    }
  });
});

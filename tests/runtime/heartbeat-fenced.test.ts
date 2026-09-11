import { describe, it, expect, vi } from 'vitest';
import { Heartbeat } from '../../src/runtime/heartbeat.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type {
  HeartbeatFencedEvent,
  HeartbeatFailedEvent,
} from '../../src/core/types.js';

/**
 * Behavioral/runtime coverage for the Heartbeat fenced reaction (Req 9.16, 9.20).
 *
 * When updateHeartbeat reports not-applied (returns false — the run's generation
 * has advanced past the one this Heartbeat holds), the Heartbeat MUST stop
 * beating and emit a `heartbeat:fenced` signal that is distinct from
 * `heartbeat:failed`. A rejected write (store error) is a different condition
 * and must still surface as `heartbeat:failed`.
 */
describe('heartbeat reaction to a fenced generation', () => {
  it('stops beating and emits heartbeat:fenced (not heartbeat:failed) when the write is not applied', async () => {
    const eventBus = new EventBus();
    const fenced: HeartbeatFencedEvent[] = [];
    const failed: HeartbeatFailedEvent[] = [];
    eventBus.on('heartbeat:fenced', (e) => fenced.push(e));
    eventBus.on('heartbeat:failed', (e) => failed.push(e));

    // Not-applied is signalled by resolving false (never throwing).
    const store = {
      updateHeartbeat: vi.fn().mockResolvedValue(false),
    } as unknown as JournalStore;

    const heartbeat = new Heartbeat(store, 'run-1', 10_000, 3, eventBus);
    heartbeat.start();

    // Let the immediate beat's promise settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Timer stopped: no longer masking staleness.
    expect(heartbeat.isRunning()).toBe(false);

    // Exactly the fenced signal, carrying the held generation; no failed signal.
    expect(fenced).toHaveLength(1);
    expect(fenced[0].runId).toBe('run-1');
    expect(fenced[0].generation).toBe(3);
    expect(failed).toHaveLength(0);
  });

  it('does not emit heartbeat:fenced when the write is applied', async () => {
    const eventBus = new EventBus();
    const fenced: HeartbeatFencedEvent[] = [];
    eventBus.on('heartbeat:fenced', (e) => fenced.push(e));

    const store = {
      updateHeartbeat: vi.fn().mockResolvedValue(true),
    } as unknown as JournalStore;

    const heartbeat = new Heartbeat(store, 'run-2', 10_000, 0, eventBus);
    heartbeat.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(heartbeat.isRunning()).toBe(true);
    expect(fenced).toHaveLength(0);

    heartbeat.stop();
  });

  it('emits heartbeat:failed (not heartbeat:fenced) when the write rejects', async () => {
    const eventBus = new EventBus();
    const fenced: HeartbeatFencedEvent[] = [];
    const failed: HeartbeatFailedEvent[] = [];
    eventBus.on('heartbeat:fenced', (e) => fenced.push(e));
    eventBus.on('heartbeat:failed', (e) => failed.push(e));

    const store = {
      updateHeartbeat: vi.fn().mockRejectedValue(new Error('store down')),
    } as unknown as JournalStore;

    const heartbeat = new Heartbeat(store, 'run-3', 10_000, 0, eventBus);
    heartbeat.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    heartbeat.stop();

    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0].error.message).toBe('store down');
    expect(fenced).toHaveLength(0);
  });
});

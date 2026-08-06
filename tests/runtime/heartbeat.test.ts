import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Heartbeat } from '../../src/runtime/heartbeat.js';
import type { JournalStore } from '../../src/stores/interface.js';

describe('Heartbeat', () => {
  const runId = 'run-abc-123';
  const intervalMs = 5000;
  let store: { updateHeartbeat: ReturnType<typeof vi.fn> };
  let heartbeat: Heartbeat;

  beforeEach(() => {
    vi.useFakeTimers();
    store = { updateHeartbeat: vi.fn().mockResolvedValue(undefined) };
    heartbeat = new Heartbeat(store as unknown as JournalStore, runId, intervalMs);
  });

  afterEach(() => {
    heartbeat.stop();
    vi.useRealTimers();
  });

  it('start() calls store.updateHeartbeat immediately', () => {
    heartbeat.start();
    expect(store.updateHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('start() calls updateHeartbeat with the correct runId', () => {
    heartbeat.start();
    expect(store.updateHeartbeat).toHaveBeenCalledWith(runId);
  });

  it('after advancing timer by intervalMs, updateHeartbeat is called again', () => {
    heartbeat.start();
    expect(store.updateHeartbeat).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(intervalMs);
    expect(store.updateHeartbeat).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(intervalMs);
    expect(store.updateHeartbeat).toHaveBeenCalledTimes(3);
  });

  it('stop() prevents further updateHeartbeat calls', () => {
    heartbeat.start();
    expect(store.updateHeartbeat).toHaveBeenCalledTimes(1);

    heartbeat.stop();
    vi.advanceTimersByTime(intervalMs * 3);
    expect(store.updateHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('isRunning() returns false before start, true after start, false after stop', () => {
    expect(heartbeat.isRunning()).toBe(false);

    heartbeat.start();
    expect(heartbeat.isRunning()).toBe(true);

    heartbeat.stop();
    expect(heartbeat.isRunning()).toBe(false);
  });

  it('double start() does not create multiple intervals', () => {
    heartbeat.start();
    heartbeat.start();

    expect(store.updateHeartbeat).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(intervalMs);
    expect(store.updateHeartbeat).toHaveBeenCalledTimes(2);
  });

  it('stop() when not running does not throw', () => {
    expect(() => heartbeat.stop()).not.toThrow();
  });
});

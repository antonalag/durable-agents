// Feature: sprint-2-runtime-core, Property 5: Heartbeat fires at configured interval
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { Heartbeat } from '../../src/runtime/heartbeat.js';
import type { JournalStore } from '../../src/stores/interface.js';

// Validates: Requirements 4.1, 4.4
describe('Property 5: Heartbeat fires at configured interval', () => {
  it('updateHeartbeat is called at least ⌊D/H⌋+1 times (immediate + interval fires)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 500 }),
        fc.integer({ min: 2, max: 20 }),
        (intervalMs, multiplier) => {
          vi.useFakeTimers();
          try {
            const duration = intervalMs * multiplier;

            const store = {
              updateHeartbeat: vi.fn().mockResolvedValue(undefined),
            } as unknown as JournalStore;

            const heartbeat = new Heartbeat(store, 'run-test', intervalMs);
            heartbeat.start();

            vi.advanceTimersByTime(duration);

            const expectedCalls = Math.floor(duration / intervalMs) + 1;
            expect(store.updateHeartbeat).toHaveBeenCalledTimes(expectedCalls);

            heartbeat.stop();
          } finally {
            vi.useRealTimers();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('first fire is immediate (before any time passes)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 10, max: 500 }), (intervalMs) => {
        vi.useFakeTimers();
        try {
          const store = {
            updateHeartbeat: vi.fn().mockResolvedValue(undefined),
          } as unknown as JournalStore;

          const heartbeat = new Heartbeat(store, 'run-test', intervalMs);
          heartbeat.start();

          expect(store.updateHeartbeat).toHaveBeenCalledTimes(1);
          expect(store.updateHeartbeat).toHaveBeenCalledWith('run-test');

          heartbeat.stop();
        } finally {
          vi.useRealTimers();
        }
      }),
      { numRuns: 100 },
    );
  });
});

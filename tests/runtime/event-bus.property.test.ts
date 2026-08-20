import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { EventBus } from '../../src/runtime/event-bus.js';
import type { RunStartedEvent, RunConfig } from '../../src/core/types.js';

describe('Property 6: EventBus delivers to all registered listeners', () => {
  it('all N registered listeners receive the emitted event, and off() removes delivery', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (n) => {
        const bus = new EventBus();
        const calls: number[] = Array.from({ length: n }, () => 0);

        const config: RunConfig = { name: 'test-workflow' };
        const event: RunStartedEvent = {
          type: 'run:started',
          timestamp: new Date(),
          runId: 'run-1',
          config,
        };

        const handlers = calls.map((_, i) => () => { calls[i]++; });

        for (const handler of handlers) {
          bus.on('run:started', handler);
        }

        bus.emit('run:started', event);

        for (let i = 0; i < n; i++) {
          expect(calls[i]).toBe(1);
        }

        const removeIdx = n - 1;
        bus.off('run:started', handlers[removeIdx]);

        bus.emit('run:started', event);

        expect(calls[removeIdx]).toBe(1);
        for (let i = 0; i < n - 1; i++) {
          expect(calls[i]).toBe(2);
        }
      }),
      { numRuns: 100 },
    );
  });
});

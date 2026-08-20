import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { formatSseEvent } from '../../src/dashboard/sse.js';
import type { DurableEvent } from '../../src/core/types.js';

const eventTypes = [
  'run:started', 'run:completed', 'run:failed', 'run:recovered',
  'step:started', 'step:completed',
  'budget:warning', 'budget:exceeded', 'loop:detected',
] as const;

const eventArb: fc.Arbitrary<DurableEvent> = fc.record({
  type: fc.constantFrom(...eventTypes),
  timestamp: fc.date({ noInvalidDate: true }),
  runId: fc.uuid(),
}).map(e => e as unknown as DurableEvent);

describe('Property 7: SSE event formatting', () => {
  it('formatted output has event: line with type and data: line with valid JSON', () => {
    fc.assert(
      fc.property(eventArb, (event) => {
        const output = formatSseEvent(event);
        // Has event: line
        expect(output).toContain(`event: ${event.type}`);
        // Has data: line
        const dataMatch = output.match(/^data: (.+)$/m);
        expect(dataMatch).not.toBeNull();
        // data is valid JSON
        const parsed = JSON.parse(dataMatch![1]);
        expect(parsed.type).toBe(event.type);
        expect(parsed.runId).toBe(event.runId);
        // Ends with double newline
        expect(output.endsWith('\n\n')).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

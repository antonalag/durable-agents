import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { detectLoop, type StepRecord } from '../../src/runtime/loop-detector.js';
import type { LoopConfig } from '../../src/core/types.js';

function step(nodeName: string, sequence: number, outputHash?: string): StepRecord {
  return { nodeName, sequence, outputHash };
}

describe('Property 3: Same-tool loop detection', () => {
  /**
   * **Validates: Requirements 3.1**
   */
  it('detects when consecutive same-name count > maxRepetitions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }), // maxRepetitions
        fc.integer({ min: 1, max: 20 }), // N consecutive same-name steps
        fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 0, maxLength: 5 }), // prefix
        (maxRep, n, prefix) => {
          const history: StepRecord[] = [
            ...prefix.map((name, i) => step(name, i)),
            ...Array.from({ length: n }, (_, i) => step('repeated_tool', prefix.length + i)),
          ];
          const config: LoopConfig = { maxRepetitions: maxRep, windowSize: 50 };
          const result = detectLoop(history, config);

          if (n > maxRep) {
            expect(result.detected).toBe(true);
            expect(result.loopType).toBe('same_tool');
            expect(result.repetitions).toBe(n);
          } else {
            // same_tool should not trigger when N <= maxRepetitions
            if (result.detected && result.loopType === 'same_tool') {
              expect(result.repetitions!).toBeGreaterThan(maxRep);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('Property 4: No-progress loop detection', () => {
  /**
   * **Validates: Requirements 3.2**
   */
  it('detects when M consecutive steps share identical outputHash', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }), // maxNoProgressSteps
        fc.integer({ min: 1, max: 15 }), // M steps with same hash
        fc.string({ minLength: 5, maxLength: 20 }), // the hash value
        (maxNoProgress, m, hash) => {
          // Distinct prefix so same_tool doesn't fire on the tail
          const prefix: StepRecord[] = [
            step('a', 0, 'unique1'),
            step('b', 1, 'unique2'),
          ];
          const tail = Array.from({ length: m }, (_, i) =>
            step(`step_${i}`, prefix.length + i, hash),
          );
          const history = [...prefix, ...tail];
          const config: LoopConfig = {
            maxNoProgressSteps: maxNoProgress,
            windowSize: 50,
            maxRepetitions: 100,
          };
          const result = detectLoop(history, config);

          if (m >= maxNoProgress) {
            expect(result.detected).toBe(true);
            expect(result.loopType).toBe('no_progress');
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('Property 5: Oscillation loop detection', () => {
  /**
   * **Validates: Requirements 3.3**
   */
  it('detects when A-B cycles exceed maxRepetitions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }), // maxRepetitions
        fc.integer({ min: 1, max: 15 }), // cycles
        fc.string({ minLength: 1, maxLength: 5 }), // name A
        fc.string({ minLength: 1, maxLength: 5 }), // name B
        (maxRep, cycles, a, b) => {
          fc.pre(a !== b); // A and B must be different

          const history: StepRecord[] = [];
          for (let i = 0; i < cycles; i++) {
            history.push(step(a, i * 2));
            history.push(step(b, i * 2 + 1));
          }

          const config: LoopConfig = {
            maxRepetitions: maxRep,
            windowSize: 50,
            maxNoProgressSteps: 100,
          };
          const result = detectLoop(history, config);

          if (cycles > maxRep && history.length >= 4) {
            expect(result.detected).toBe(true);
            expect(result.loopType).toBe('oscillation');
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('Property 6: Loop detector disabled without config', () => {
  /**
   * **Validates: Requirements 3.5**
   */
  it('returns { detected: false } for any history when config is undefined', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            nodeName: fc.string({ minLength: 1, maxLength: 10 }),
            sequence: fc.nat({ max: 100 }),
            outputHash: fc.option(fc.string({ minLength: 5, maxLength: 20 }), { nil: undefined }),
          }),
          { minLength: 0, maxLength: 30 },
        ),
        (history) => {
          const result = detectLoop(history, undefined);
          expect(result).toEqual({ detected: false });
        },
      ),
      { numRuns: 200 },
    );
  });
});

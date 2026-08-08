// Feature: sprint-3-framework-adapters, Property 7: Operation key determinism
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeOperationKey } from '../../src/serialization/operation-key.js';

// **Validates: Requirements 5.5**
describe('Property 7: Operation key determinism', () => {
  it('computeOperationKey produces identical output for identical inputs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.nat({ max: 10_000 }),
        (runId, name, sequence) => {
          const key1 = computeOperationKey(runId, name, sequence);
          const key2 = computeOperationKey(runId, name, sequence);
          expect(key1).toBe(key2);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('different inputs produce different keys', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.nat({ max: 10_000 }),
        fc.nat({ max: 10_000 }),
        (runId, name, seq1, seq2) => {
          fc.pre(seq1 !== seq2);
          const key1 = computeOperationKey(runId, name, seq1);
          const key2 = computeOperationKey(runId, name, seq2);
          expect(key1).not.toBe(key2);
        },
      ),
      { numRuns: 100 },
    );
  });
});

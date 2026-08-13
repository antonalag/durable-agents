import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validateRunConfig } from '../../src/runtime/config-validation.js';
import { DurableError } from '../../src/errors.js';

const invalidConfigArb = fc.oneof(
  // Empty name
  fc.record({ name: fc.constant(''), heartbeatIntervalMs: fc.constant(1000), staleTimeoutMs: fc.constant(5000) }),
  // Whitespace name
  fc.record({ name: fc.constant('   '), heartbeatIntervalMs: fc.constant(1000), staleTimeoutMs: fc.constant(5000) }),
  // heartbeat >= staleTimeout
  fc.record({ name: fc.constant('valid'), heartbeatIntervalMs: fc.integer({ min: 5000, max: 10000 }), staleTimeoutMs: fc.integer({ min: 1000, max: 5000 }) }),
  // Negative maxCostUsd
  fc.record({ name: fc.constant('valid'), budget: fc.record({ maxCostUsd: fc.double({ min: -100, max: -0.01, noNaN: true }) }) }),
  // warningThreshold outside (0,1]
  fc.record({ name: fc.constant('valid'), budget: fc.record({ warningThreshold: fc.oneof(fc.constant(0), fc.double({ min: 1.01, max: 10, noNaN: true })) }) }),
  // windowSize < 2
  fc.record({ name: fc.constant('valid'), loopDetection: fc.record({ windowSize: fc.integer({ min: -10, max: 1 }) }) }),
  // maxRepetitions < 1
  fc.record({ name: fc.constant('valid'), loopDetection: fc.record({ maxRepetitions: fc.integer({ min: -10, max: 0 }) }) }),
);

/**
 * Property 11: Configuration validation rejects invalid configs
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
 */
describe('Property 11: Configuration validation rejects invalid configs', () => {
  it('throws DurableError with INVALID_CONFIG for any invalid config', () => {
    fc.assert(
      fc.property(invalidConfigArb, (config) => {
        try {
          validateRunConfig(config as Parameters<typeof validateRunConfig>[0]);
          expect.fail('Expected validateRunConfig to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(DurableError);
          expect((err as DurableError).code).toBe('INVALID_CONFIG');
        }
      }),
      { numRuns: 200 },
    );
  });
});

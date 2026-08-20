import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { DurableError, type DurableErrorCode } from '../../src/errors.js';

const allCodes: DurableErrorCode[] = [
  'BUDGET_EXCEEDED', 'LOOP_DETECTED', 'RUN_TERMINATED',
  'STORE_ERROR', 'INVALID_CONFIG', 'DASHBOARD_PORT_IN_USE',
];

/**
 * Property 9: Typed error construction and serialization
 */
describe('Property 9: Typed error construction and serialization', () => {
  it('all DurableError instances satisfy invariants', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allCodes),
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
        (code, message, causeMsg) => {
          const cause = causeMsg ? new Error(causeMsg) : undefined;
          const err = new DurableError(code, message, cause ? { cause } : undefined);

          expect(err).toBeInstanceOf(Error);
          expect(err).toBeInstanceOf(DurableError);
          expect(err.code).toBe(code);
          expect(err.message).toBe(message);
          expect(err.name).toBe('DurableError');
          expect(typeof err.stack).toBe('string');
          expect(err.stack!.length).toBeGreaterThan(0);

          const json = err.toJSON();
          expect(json.code).toBe(code);
          expect(json.message).toBe(message);
          if (causeMsg) {
            expect(json.cause).toBe(causeMsg);
            expect(err.cause).toBe(cause);
          } else {
            expect(json.cause).toBeUndefined();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

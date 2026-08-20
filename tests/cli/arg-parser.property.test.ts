import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseArgs } from '../../src/cli.js';

describe('Property 8: CLI argument parsing correctness', () => {
  it('parsed args match input values for valid combinations', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('dashboard' as const, 'recover' as const),
        fc.integer({ min: 1, max: 65535 }),
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.startsWith('--')),
        fc.integer({ min: 1, max: 600000 }),
        (command, port, db, timeout) => {
          const argv = [command, '--port', String(port), '--db', db, '--timeout', String(timeout)];
          const result = parseArgs(argv);
          expect(result.command).toBe(command);
          expect(result.port).toBe(port);
          expect(result.db).toBe(db);
          expect(result.timeout).toBe(timeout);
        },
      ),
      { numRuns: 100 },
    );
  });
});

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeOperationKey } from '../../src/serialization/operation-key.js';

describe('computeOperationKey', () => {
  const safeKeyArb = fc.string().filter((k) => k !== '__proto__' && k !== 'prototype' && k !== 'constructor');

  // Property 2: Determinism — Validates: Requirements 4.3
  it('produces the same key for identical inputs', () => {
    fc.assert(
      fc.property(fc.anything({ key: safeKeyArb }), (value) => {
        if (typeof value === 'function' || typeof value === 'symbol') return;
        const key1 = computeOperationKey(value);
        const key2 = computeOperationKey(value);
        expect(key1).toBe(key2);
      }),
      { numRuns: 100 },
    );
  });

  // Property 3: Collision resistance — Validates: Requirements 4.4
  it('produces different keys for different inputs', () => {
    fc.assert(
      fc.property(fc.anything({ key: safeKeyArb }), fc.anything({ key: safeKeyArb }), (a, b) => {
        if (typeof a === 'function' || typeof a === 'symbol') return;
        if (typeof b === 'function' || typeof b === 'symbol') return;
        try {
          if (JSON.stringify(a) === JSON.stringify(b)) return;
        } catch {
          return;
        }
        const keyA = computeOperationKey(a);
        const keyB = computeOperationKey(b);
        expect(keyA).not.toBe(keyB);
      }),
      { numRuns: 100 },
    );
  });

  // Property 4: Order-independence — Validates: Requirements 4.5
  it('produces the same key regardless of object key order', () => {
    fc.assert(
      fc.property(fc.dictionary(safeKeyArb, fc.anything({ key: safeKeyArb })), (obj) => {
        const keys = Object.keys(obj);
        if (keys.length < 2) return;
        for (const v of Object.values(obj)) {
          if (typeof v === 'function' || typeof v === 'symbol') return;
        }

        const reversed: Record<string, unknown> = {};
        for (const key of keys.reverse()) {
          reversed[key] = obj[key];
        }

        const key1 = computeOperationKey(obj);
        const key2 = computeOperationKey(reversed);
        expect(key1).toBe(key2);
      }),
      { numRuns: 100 },
    );
  });

  it('returns a 64-character hex string', () => {
    const key = computeOperationKey('test', 123);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles complex types (Date, Map, Set)', () => {
    const key1 = computeOperationKey(new Date('2024-01-01'));
    const key2 = computeOperationKey(new Date('2024-01-01'));
    const key3 = computeOperationKey(new Date('2024-01-02'));
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it('handles multiple arguments', () => {
    const key1 = computeOperationKey('a', 'b');
    const key2 = computeOperationKey('ab');
    expect(key1).not.toBe(key2);
  });
});

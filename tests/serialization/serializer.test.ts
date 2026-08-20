import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { serialize, deserialize } from '../../src/serialization/serializer.js';

describe('serializer', () => {
  // Property 1: Serialization round-trip
  it('round-trips arbitrary JSON-compatible values', () => {
    const safeKeyArb = fc.string().filter((k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype');
    fc.assert(
      fc.property(fc.anything({ key: safeKeyArb }), (value) => {
        if (typeof value === 'function' || typeof value === 'symbol') return;

        const result = deserialize(serialize(value));
        expect(result).toEqual(value);
      }),
      { numRuns: 100 },
    );
  });

  it('round-trips Date objects', () => {
    fc.assert(
      fc.property(fc.date({ noInvalidDate: true }), (date) => {
        const result = deserialize<Date>(serialize(date));
        expect(result).toBeInstanceOf(Date);
        expect(result.getTime()).toBe(date.getTime());
      }),
      { numRuns: 100 },
    );
  });

  it('round-trips BigInt values', () => {
    fc.assert(
      fc.property(fc.bigInt(), (big) => {
        const result = deserialize<bigint>(serialize(big));
        expect(result).toBe(big);
      }),
      { numRuns: 100 },
    );
  });
});

describe('serializer edge cases', () => {
  it('preserves Map key-value pairs', () => {
    const original = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const result = deserialize<Map<string, number>>(serialize(original));
    expect(result).toBeInstanceOf(Map);
    expect(result.get('a')).toBe(1);
    expect(result.get('b')).toBe(2);
  });

  it('preserves Set elements', () => {
    const original = new Set([1, 2, 3]);
    const result = deserialize<Set<number>>(serialize(original));
    expect(result).toBeInstanceOf(Set);
    expect(result.has(1)).toBe(true);
    expect(result.has(2)).toBe(true);
    expect(result.has(3)).toBe(true);
    expect(result.size).toBe(3);
  });

  it('preserves Buffer content', () => {
    const original = Buffer.from('hello world', 'utf-8');
    const result = deserialize<Buffer>(serialize(original));
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString('utf-8')).toBe('hello world');
  });

  it('preserves undefined fields in objects', () => {
    const original = { a: 1, b: undefined, c: 'hello' };
    const result = deserialize<typeof original>(serialize(original));
    expect(result).toHaveProperty('b');
    expect(result.b).toBeUndefined();
    expect(result.a).toBe(1);
    expect(result.c).toBe('hello');
  });

  it('preserves nested mixed types', () => {
    const original = {
      date: new Date('2024-01-01'),
      map: new Map([['key', new Set([1, 2])]]),
      big: BigInt(9007199254740991),
      buf: Buffer.from([0x01, 0x02, 0x03]),
    };
    const result = deserialize<typeof original>(serialize(original));
    expect(result.date).toBeInstanceOf(Date);
    expect(result.date.getTime()).toBe(original.date.getTime());
    expect(result.map).toBeInstanceOf(Map);
    expect(result.map.get('key')).toBeInstanceOf(Set);
    expect(result.big).toBe(original.big);
    expect(Buffer.isBuffer(result.buf)).toBe(true);
  });
});

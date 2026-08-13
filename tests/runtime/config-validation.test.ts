import { describe, it, expect } from 'vitest';
import { validateRunConfig } from '../../src/runtime/config-validation.js';
import { DurableError } from '../../src/errors.js';

describe('validateRunConfig', () => {
  const validConfig = { name: 'my-workflow' };

  describe('valid configs', () => {
    it('passes with just a name', () => {
      expect(() => validateRunConfig(validConfig)).not.toThrow();
    });

    it('passes with all optional fields valid', () => {
      expect(() =>
        validateRunConfig({
          name: 'full-config',
          heartbeatIntervalMs: 5000,
          staleTimeoutMs: 30000,
          budget: { maxCostUsd: 10, warningThreshold: 0.8 },
          loopDetection: { windowSize: 10, maxRepetitions: 3 },
        }),
      ).not.toThrow();
    });

    it('passes with no budget or loopDetection', () => {
      expect(() =>
        validateRunConfig({
          name: 'minimal',
          heartbeatIntervalMs: 1000,
          staleTimeoutMs: 5000,
        }),
      ).not.toThrow();
    });
  });

  describe('name validation', () => {
    it('throws INVALID_CONFIG for empty name', () => {
      expect(() => validateRunConfig({ name: '' })).toThrow(DurableError);
      try {
        validateRunConfig({ name: '' });
      } catch (err) {
        expect(err).toBeInstanceOf(DurableError);
        expect((err as DurableError).code).toBe('INVALID_CONFIG');
      }
    });

    it('throws INVALID_CONFIG for whitespace-only name', () => {
      expect(() => validateRunConfig({ name: '   ' })).toThrow(DurableError);
      try {
        validateRunConfig({ name: '   ' });
      } catch (err) {
        expect((err as DurableError).code).toBe('INVALID_CONFIG');
      }
    });
  });

  describe('heartbeat vs staleTimeout', () => {
    it('throws when heartbeatIntervalMs equals staleTimeoutMs', () => {
      expect(() =>
        validateRunConfig({ name: 'test', heartbeatIntervalMs: 5000, staleTimeoutMs: 5000 }),
      ).toThrow(DurableError);
      try {
        validateRunConfig({ name: 'test', heartbeatIntervalMs: 5000, staleTimeoutMs: 5000 });
      } catch (err) {
        expect((err as DurableError).code).toBe('INVALID_CONFIG');
      }
    });

    it('throws when heartbeatIntervalMs is greater than staleTimeoutMs', () => {
      expect(() =>
        validateRunConfig({ name: 'test', heartbeatIntervalMs: 10000, staleTimeoutMs: 5000 }),
      ).toThrow(DurableError);
      try {
        validateRunConfig({ name: 'test', heartbeatIntervalMs: 10000, staleTimeoutMs: 5000 });
      } catch (err) {
        expect((err as DurableError).code).toBe('INVALID_CONFIG');
      }
    });
  });

  describe('budget validation', () => {
    it('throws when maxCostUsd is negative', () => {
      expect(() =>
        validateRunConfig({ name: 'test', budget: { maxCostUsd: -1 } }),
      ).toThrow(DurableError);
      try {
        validateRunConfig({ name: 'test', budget: { maxCostUsd: -1 } });
      } catch (err) {
        expect((err as DurableError).code).toBe('INVALID_CONFIG');
      }
    });

    it('throws when warningThreshold is 0', () => {
      expect(() =>
        validateRunConfig({ name: 'test', budget: { warningThreshold: 0 } }),
      ).toThrow(DurableError);
      try {
        validateRunConfig({ name: 'test', budget: { warningThreshold: 0 } });
      } catch (err) {
        expect((err as DurableError).code).toBe('INVALID_CONFIG');
      }
    });

    it('throws when warningThreshold is greater than 1', () => {
      expect(() =>
        validateRunConfig({ name: 'test', budget: { warningThreshold: 1.5 } }),
      ).toThrow(DurableError);
      try {
        validateRunConfig({ name: 'test', budget: { warningThreshold: 1.5 } });
      } catch (err) {
        expect((err as DurableError).code).toBe('INVALID_CONFIG');
      }
    });

    it('does NOT throw when warningThreshold is exactly 1', () => {
      expect(() =>
        validateRunConfig({ name: 'test', budget: { warningThreshold: 1 } }),
      ).not.toThrow();
    });
  });

  describe('loopDetection validation', () => {
    it('throws when windowSize is less than 2', () => {
      expect(() =>
        validateRunConfig({ name: 'test', loopDetection: { windowSize: 1 } }),
      ).toThrow(DurableError);
      try {
        validateRunConfig({ name: 'test', loopDetection: { windowSize: 1 } });
      } catch (err) {
        expect((err as DurableError).code).toBe('INVALID_CONFIG');
      }
    });

    it('throws when maxRepetitions is less than 1', () => {
      expect(() =>
        validateRunConfig({ name: 'test', loopDetection: { maxRepetitions: 0 } }),
      ).toThrow(DurableError);
      try {
        validateRunConfig({ name: 'test', loopDetection: { maxRepetitions: 0 } });
      } catch (err) {
        expect((err as DurableError).code).toBe('INVALID_CONFIG');
      }
    });
  });

  describe('first violation wins', () => {
    it('reports name error before budget error', () => {
      try {
        validateRunConfig({ name: '', budget: { maxCostUsd: -5 } });
      } catch (err) {
        expect(err).toBeInstanceOf(DurableError);
        expect((err as DurableError).code).toBe('INVALID_CONFIG');
        expect((err as DurableError).message).toMatch(/name/i);
      }
    });
  });
});

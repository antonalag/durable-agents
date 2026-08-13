import { describe, it, expect } from 'vitest';
import { DurableError, type DurableErrorCode } from '../../src/errors.js';

const ALL_CODES: DurableErrorCode[] = [
  'BUDGET_EXCEEDED',
  'LOOP_DETECTED',
  'RUN_TERMINATED',
  'STORE_ERROR',
  'INVALID_CONFIG',
  'DASHBOARD_PORT_IN_USE',
];

describe('DurableError', () => {
  describe('construction for each error code', () => {
    it.each(ALL_CODES)('constructs with code %s', (code) => {
      const err = new DurableError(code, `msg for ${code}`);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`msg for ${code}`);
    });
  });

  describe('instanceof checks', () => {
    it('is instanceof Error', () => {
      const err = new DurableError('STORE_ERROR', 'db fail');
      expect(err).toBeInstanceOf(Error);
    });

    it('is instanceof DurableError', () => {
      const err = new DurableError('STORE_ERROR', 'db fail');
      expect(err).toBeInstanceOf(DurableError);
    });
  });

  describe('name property', () => {
    it('name is DurableError', () => {
      const err = new DurableError('BUDGET_EXCEEDED', 'over budget');
      expect(err.name).toBe('DurableError');
    });
  });

  describe('message property', () => {
    it('message matches the input', () => {
      const err = new DurableError('LOOP_DETECTED', 'stuck in loop');
      expect(err.message).toBe('stuck in loop');
    });
  });

  describe('stack trace preservation', () => {
    it('stack is a non-empty string', () => {
      const err = new DurableError('RUN_TERMINATED', 'killed');
      expect(err.stack).toBeDefined();
      expect(typeof err.stack).toBe('string');
      expect(err.stack!.length).toBeGreaterThan(0);
    });

    it('stack contains the error message', () => {
      const err = new DurableError('RUN_TERMINATED', 'killed');
      expect(err.stack).toContain('killed');
    });
  });

  describe('toJSON()', () => {
    it('without cause returns { code, message }', () => {
      const err = new DurableError('INVALID_CONFIG', 'bad config');
      expect(err.toJSON()).toEqual({
        code: 'INVALID_CONFIG',
        message: 'bad config',
      });
    });

    it('with cause returns { code, message, cause }', () => {
      const original = new Error('connection refused');
      const err = new DurableError('STORE_ERROR', 'write failed', { cause: original });
      expect(err.toJSON()).toEqual({
        code: 'STORE_ERROR',
        message: 'write failed',
        cause: 'connection refused',
      });
    });
  });

  describe('cause chaining', () => {
    it('preserves the cause when provided', () => {
      const original = new Error('ECONNREFUSED');
      const err = new DurableError('STORE_ERROR', 'store unavailable', { cause: original });
      expect(err.cause).toBe(original);
      expect(err.cause!.message).toBe('ECONNREFUSED');
    });

    it('cause is undefined when not provided', () => {
      const err = new DurableError('BUDGET_EXCEEDED', 'over limit');
      expect(err.cause).toBeUndefined();
    });
  });
});

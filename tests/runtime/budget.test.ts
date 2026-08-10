import { describe, it, expect } from 'vitest';
import { checkBudget } from '../../src/runtime/budget.js';

describe('checkBudget', () => {
  const baseTotals = { cost: 0, tokens: 0, steps: 0 };

  describe('undefined config', () => {
    it('returns ok with percentUsed 0', () => {
      const result = checkBudget({
        totals: { cost: 999, tokens: 999999, steps: 9999 },
        elapsedMs: 999999,
        config: undefined,
      });

      expect(result.status).toBe('ok');
      expect(result.percentUsed).toBe(0);
    });
  });

  describe('all within limits', () => {
    it('returns ok when totals are well below limits', () => {
      const result = checkBudget({
        totals: { cost: 2, tokens: 0, steps: 20 },
        elapsedMs: 1000,
        config: { maxCostUsd: 10, maxSteps: 100 },
      });

      expect(result.status).toBe('ok');
      expect(result.percentUsed).toBeCloseTo(0.2);
    });
  });

  describe('warning threshold', () => {
    it('returns warning at default threshold (0.8)', () => {
      const result = checkBudget({
        totals: { cost: 8, tokens: 0, steps: 0 },
        elapsedMs: 0,
        config: { maxCostUsd: 10 },
      });

      expect(result.status).toBe('warning');
      expect(result.triggeredBy).toBe('maxCostUsd');
      expect(result.percentUsed).toBeCloseTo(0.8);
    });

    it('returns warning above threshold but below limit', () => {
      const result = checkBudget({
        totals: { cost: 9, tokens: 0, steps: 0 },
        elapsedMs: 0,
        config: { maxCostUsd: 10 },
      });

      expect(result.status).toBe('warning');
      expect(result.triggeredBy).toBe('maxCostUsd');
      expect(result.percentUsed).toBeCloseTo(0.9);
    });

    it('uses custom warningThreshold', () => {
      const result = checkBudget({
        totals: { cost: 0, tokens: 0, steps: 5 },
        elapsedMs: 0,
        config: { maxSteps: 10, warningThreshold: 0.5 },
      });

      expect(result.status).toBe('warning');
      expect(result.triggeredBy).toBe('maxSteps');
    });
  });

  describe('exceeded', () => {
    it('returns exceeded when exactly at limit', () => {
      const result = checkBudget({
        totals: { cost: 10, tokens: 0, steps: 0 },
        elapsedMs: 0,
        config: { maxCostUsd: 10 },
      });

      expect(result.status).toBe('exceeded');
      expect(result.triggeredBy).toBe('maxCostUsd');
      expect(result.percentUsed).toBeCloseTo(1.0);
    });

    it('returns exceeded when above limit', () => {
      const result = checkBudget({
        totals: { cost: 0, tokens: 0, steps: 15 },
        elapsedMs: 0,
        config: { maxSteps: 10 },
      });

      expect(result.status).toBe('exceeded');
      expect(result.triggeredBy).toBe('maxSteps');
    });

    it('returns exceeded for maxDurationMs', () => {
      const result = checkBudget({
        totals: baseTotals,
        elapsedMs: 35000,
        config: { maxDurationMs: 30000 },
      });

      expect(result.status).toBe('exceeded');
      expect(result.triggeredBy).toBe('maxDurationMs');
    });
  });

  describe('edge cases: NaN, Infinity, zero, negatives', () => {
    it('treats NaN cost as exceeded', () => {
      const result = checkBudget({
        totals: { cost: NaN, tokens: 0, steps: 0 },
        elapsedMs: 0,
        config: { maxCostUsd: 10 },
      });

      expect(result.status).toBe('exceeded');
    });

    it('treats Infinity cost as exceeded', () => {
      const result = checkBudget({
        totals: { cost: Infinity, tokens: 0, steps: 0 },
        elapsedMs: 0,
        config: { maxCostUsd: 10 },
      });

      expect(result.status).toBe('exceeded');
    });

    it('treats zero limit as exceeded (0/0 = NaN)', () => {
      const result = checkBudget({
        totals: { cost: 0, tokens: 0, steps: 0 },
        elapsedMs: 0,
        config: { maxSteps: 0 },
      });

      expect(result.status).toBe('exceeded');
    });

    it('treats negative totals within limit as ok', () => {
      const result = checkBudget({
        totals: { cost: -5, tokens: 0, steps: 0 },
        elapsedMs: 0,
        config: { maxCostUsd: 10 },
      });

      expect(result.status).toBe('ok');
    });
  });

  describe('multiple limits', () => {
    it('returns exceeded when any limit is exceeded (most severe wins)', () => {
      const result = checkBudget({
        totals: { cost: 5, tokens: 0, steps: 15 },
        elapsedMs: 0,
        config: { maxCostUsd: 10, maxSteps: 10 },
      });

      expect(result.status).toBe('exceeded');
      expect(result.triggeredBy).toBe('maxSteps');
    });

    it('returns warning when one limit is at warning and others ok', () => {
      const result = checkBudget({
        totals: { cost: 8, tokens: 0, steps: 5 },
        elapsedMs: 0,
        config: { maxCostUsd: 10, maxSteps: 10 },
      });

      expect(result.status).toBe('warning');
      expect(result.triggeredBy).toBe('maxCostUsd');
    });
  });
});

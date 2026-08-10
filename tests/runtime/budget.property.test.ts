import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { checkBudget, type BudgetStatus } from '../../src/runtime/budget.js';
import type { BudgetConfig } from '../../src/core/types.js';

const SEVERITY: Record<BudgetStatus, number> = { ok: 0, warning: 1, exceeded: 2 };

/**
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4
 */
describe('Property 1: Budget severity monotonicity', () => {
  it('status equals the most severe across all configured limits', () => {
    fc.assert(
      fc.property(
        fc.record({
          maxCostUsd: fc.option(fc.double({ min: 0.01, max: 1000, noNaN: true }), { nil: undefined }),
          maxSteps: fc.option(fc.integer({ min: 1, max: 10000 }), { nil: undefined }),
          maxDurationMs: fc.option(fc.integer({ min: 100, max: 600000 }), { nil: undefined }),
          warningThreshold: fc.option(fc.double({ min: 0.1, max: 0.99, noNaN: true }), { nil: undefined }),
        }),
        fc.record({
          cost: fc.double({ min: 0, max: 2000, noNaN: true }),
          tokens: fc.nat({ max: 100000 }),
          steps: fc.nat({ max: 20000 }),
        }),
        fc.nat({ max: 700000 }),
        (configPartial, totals, elapsedMs) => {
          const config: BudgetConfig = {};
          if (configPartial.maxCostUsd !== undefined) config.maxCostUsd = configPartial.maxCostUsd;
          if (configPartial.maxSteps !== undefined) config.maxSteps = configPartial.maxSteps;
          if (configPartial.maxDurationMs !== undefined) config.maxDurationMs = configPartial.maxDurationMs;
          if (configPartial.warningThreshold !== undefined) config.warningThreshold = configPartial.warningThreshold;

          const hasLimits = config.maxCostUsd !== undefined || config.maxSteps !== undefined || config.maxDurationMs !== undefined;
          if (!hasLimits) return;

          const result = checkBudget({ totals, elapsedMs, config });
          const threshold = config.warningThreshold ?? 0.8;

          let expectedSeverity = 0;
          const limits: Array<{ current: number; limit: number | undefined }> = [
            { current: totals.cost, limit: config.maxCostUsd },
            { current: totals.steps, limit: config.maxSteps },
            { current: elapsedMs, limit: config.maxDurationMs },
          ];

          for (const { current, limit } of limits) {
            if (limit === undefined) continue;
            const percent = current / limit;
            if (!Number.isFinite(percent) || current >= limit) {
              expectedSeverity = Math.max(expectedSeverity, SEVERITY.exceeded);
            } else if (percent >= threshold) {
              expectedSeverity = Math.max(expectedSeverity, SEVERITY.warning);
            }
          }

          const expectedStatus: BudgetStatus =
            expectedSeverity === 2 ? 'exceeded' :
            expectedSeverity === 1 ? 'warning' : 'ok';

          expect(result.status).toBe(expectedStatus);
        },
      ),
      { numRuns: 200 },
    );
  });
});

/**
 * Validates: Requirements 1.5
 */
describe('Property 2: No-config budget is always ok', () => {
  it('returns ok with percentUsed 0 regardless of totals', () => {
    fc.assert(
      fc.property(
        fc.record({
          cost: fc.double({ min: -1e15, max: 1e15, noNaN: true }),
          tokens: fc.integer({ min: -1000000, max: Number.MAX_SAFE_INTEGER }),
          steps: fc.integer({ min: -1000000, max: Number.MAX_SAFE_INTEGER }),
        }),
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        (totals, elapsedMs) => {
          const result = checkBudget({ totals, elapsedMs, config: undefined });
          expect(result.status).toBe('ok');
          expect(result.percentUsed).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

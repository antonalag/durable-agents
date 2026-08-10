import type { BudgetConfig } from '../core/types.js';

export type BudgetStatus = 'ok' | 'warning' | 'exceeded';

export interface BudgetCheckInput {
  totals: { cost: number; tokens: number; steps: number };
  elapsedMs: number;
  config: BudgetConfig | undefined;
}

export interface BudgetCheckResult {
  status: BudgetStatus;
  triggeredBy?: 'maxCostUsd' | 'maxSteps' | 'maxDurationMs';
  percentUsed: number;
}

const SEVERITY: Record<BudgetStatus, number> = { ok: 0, warning: 1, exceeded: 2 };

export function checkBudget(input: BudgetCheckInput): BudgetCheckResult {
  const { totals, elapsedMs, config } = input;

  if (config === undefined) {
    return { status: 'ok', percentUsed: 0 };
  }

  const threshold = config.warningThreshold ?? 0.8;

  let worstStatus: BudgetStatus = 'ok';
  let worstPercent = 0;
  let worstTrigger: BudgetCheckResult['triggeredBy'] | undefined;

  const limits: Array<{
    key: 'maxCostUsd' | 'maxSteps' | 'maxDurationMs';
    current: number;
    limit: number | undefined;
  }> = [
    { key: 'maxCostUsd', current: totals.cost, limit: config.maxCostUsd },
    { key: 'maxSteps', current: totals.steps, limit: config.maxSteps },
    { key: 'maxDurationMs', current: elapsedMs, limit: config.maxDurationMs },
  ];

  for (const { key, current, limit } of limits) {
    if (limit === undefined) continue;

    const percent = current / limit;

    // NaN or Infinity → treat as exceeded
    if (!Number.isFinite(percent)) {
      if (SEVERITY['exceeded'] > SEVERITY[worstStatus]) {
        worstStatus = 'exceeded';
      }
      worstPercent = Infinity;
      worstTrigger = key;
      continue;
    }

    if (percent > worstPercent) {
      worstPercent = percent;
      worstTrigger = key;
    }

    if (current >= limit) {
      if (SEVERITY['exceeded'] > SEVERITY[worstStatus]) {
        worstStatus = 'exceeded';
      }
    } else if (percent >= threshold) {
      if (SEVERITY['warning'] > SEVERITY[worstStatus]) {
        worstStatus = 'warning';
      }
    }
  }

  return {
    status: worstStatus,
    triggeredBy: worstTrigger,
    percentUsed: worstPercent,
  };
}

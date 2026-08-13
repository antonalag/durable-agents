import { DurableError } from '../errors.js';
import type { BudgetConfig, LoopConfig } from '../core/types.js';

export function validateRunConfig(config: {
  name: string;
  heartbeatIntervalMs?: number;
  staleTimeoutMs?: number;
  budget?: BudgetConfig;
  loopDetection?: LoopConfig;
}): void {
  if (!config.name || config.name.trim().length === 0) {
    throw new DurableError('INVALID_CONFIG', 'Workflow name must be a non-empty string');
  }

  const heartbeat = config.heartbeatIntervalMs;
  const stale = config.staleTimeoutMs;
  if (heartbeat !== undefined && stale !== undefined && heartbeat >= stale) {
    throw new DurableError(
      'INVALID_CONFIG',
      `heartbeatIntervalMs (${heartbeat}) must be less than staleTimeoutMs (${stale})`,
    );
  }

  if (config.budget) {
    if (config.budget.maxCostUsd !== undefined && config.budget.maxCostUsd < 0) {
      throw new DurableError('INVALID_CONFIG', 'budget.maxCostUsd must be non-negative');
    }
    if (config.budget.warningThreshold !== undefined) {
      if (config.budget.warningThreshold <= 0 || config.budget.warningThreshold > 1) {
        throw new DurableError('INVALID_CONFIG', 'budget.warningThreshold must be in range (0, 1]');
      }
    }
  }

  if (config.loopDetection) {
    if (config.loopDetection.windowSize !== undefined && config.loopDetection.windowSize < 2) {
      throw new DurableError('INVALID_CONFIG', 'loopDetection.windowSize must be at least 2');
    }
    if (
      config.loopDetection.maxRepetitions !== undefined &&
      config.loopDetection.maxRepetitions < 1
    ) {
      throw new DurableError('INVALID_CONFIG', 'loopDetection.maxRepetitions must be at least 1');
    }
  }
}

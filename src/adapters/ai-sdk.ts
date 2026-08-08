import { randomUUID } from 'node:crypto';
import type { TokenCost } from '../core/types.js';
import type { DurableContextImpl } from '../runtime/context.js';
import type { EventBus } from '../runtime/event-bus.js';
import type { JournalStore } from '../stores/interface.js';
import { computeOperationKey } from '../serialization/operation-key.js';
import { assertPeerDependency } from './peer-check.js';

export interface AiSdkDurableContext {
  store: JournalStore;
  ctx: DurableContextImpl;
  eventBus: EventBus;
}

export function extractAiSdkTokens(response: unknown): TokenCost {
  const usage = (response as Record<string, unknown>)?.usage as
    | Record<string, unknown>
    | undefined;

  if (!usage || typeof usage !== 'object') {
    return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }

  return {
    inputTokens: typeof usage.promptTokens === 'number' ? usage.promptTokens : 0,
    outputTokens: typeof usage.completionTokens === 'number' ? usage.completionTokens : 0,
    costUsd: 0,
  };
}

export async function withDurability<T>(
  durableCtx: AiSdkDurableContext,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  assertPeerDependency('ai', '4.0.0', 'ai-sdk');

  if (!durableCtx?.ctx) {
    throw new TypeError(
      'withDurability requires a valid AiSdkDurableContext with a DurableContextImpl',
    );
  }

  const { store, ctx, eventBus } = durableCtx;
  const operationKey = computeOperationKey(ctx.run.runId, name);

  // Recovery path: return stored result without re-executing (no double-counting tokens)
  const existing = await store.getOutcomeByKey(operationKey);
  if (existing) {
    return existing.result as T;
  }

  // Fresh execution path
  const stepId = randomUUID();
  const now = new Date();
  const zeroCost: TokenCost = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  await store.createStep({
    stepId,
    runId: ctx.run.runId,
    nodeName: name,
    sequence: -1,
    status: 'running',
    startedAt: now,
    cost: zeroCost,
    attempt: 1,
  });

  const startMs = Date.now();

  try {
    const result = await fn();
    const durationMs = Date.now() - startMs;
    const tokens = extractAiSdkTokens(result);

    if (tokens.inputTokens === 0 && tokens.outputTokens === 0) {
      (eventBus as unknown as { emit(type: string, event: unknown): void }).emit(
        'adapter:warning',
        {
          type: 'adapter:warning',
          timestamp: new Date(),
          runId: ctx.run.runId,
          stepId,
          nodeName: name,
          message: `AI SDK response for step "${name}" has no token usage metadata`,
        },
      );
    }

    await store.recordOutcome({
      outcomeId: randomUUID(),
      stepId,
      operationType: 'llm_call',
      operationKey,
      result,
      tokens,
      durationMs,
      recordedAt: new Date(),
    });

    await store.updateStep(stepId, {
      status: 'completed',
      completedAt: new Date(),
      cost: tokens,
    });

    return result;
  } catch (error) {
    await store.updateStep(stepId, {
      status: 'failed',
      completedAt: new Date(),
    });
    throw error;
  }
}

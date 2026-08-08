import type { DurableContextImpl } from '../runtime/context.js';
import { computeOperationKey } from '../serialization/operation-key.js';

export function idempotent<TArgs, TResult>(
  ctx: DurableContextImpl,
  toolName: string,
  args: TArgs,
  fn: () => Promise<TResult>,
): Promise<TResult> {
  const operationKey = computeOperationKey(ctx.run.runId, toolName, args);
  return ctx.idempotent(operationKey, fn);
}

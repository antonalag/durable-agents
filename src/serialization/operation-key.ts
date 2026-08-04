import { createHash } from 'node:crypto';
import superjson from 'superjson';

function sortKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date || value instanceof Map || value instanceof Set) return value;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function computeOperationKey(...inputs: unknown[]): string {
  const parts = inputs.map((input) => superjson.stringify(sortKeys(input)));
  const joined = parts.join('\0');
  return createHash('sha256').update(joined).digest('hex');
}

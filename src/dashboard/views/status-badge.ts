import { escapeHtml } from '../escape.js';

const ALL_STATUSES = new Set([
  'pending', 'running', 'completed', 'failed', 'stale', 'terminated', 'skipped',
]);

export function statusBadge(status: string): string {
  const safeStatus = ALL_STATUSES.has(status) ? status : 'unknown';
  const cls = `badge badge-${safeStatus}`;
  return `<span class="${cls}">${escapeHtml(status)}</span>`;
}

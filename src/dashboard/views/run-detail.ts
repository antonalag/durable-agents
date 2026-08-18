import type { ExecutionRun, Step } from '../../core/types.js';
import { escapeHtml } from '../escape.js';
import { layout } from './layout.js';

function statusBadge(status: string): string {
  const cls = `badge badge-${status}`;
  return `<span class="${cls}">${status}</span>`;
}

function formatDuration(step: Step): string {
  if (!step.completedAt) return '—';
  const ms = step.completedAt.getTime() - step.startedAt.getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function stepTimeline(steps: Step[]): string {
  const sorted = [...steps].sort((a, b) => a.sequence - b.sequence);

  if (sorted.length === 0) {
    return '<div class="empty-state"><p>No steps recorded.</p></div>';
  }

  const rows = sorted
    .map((step) => {
      const isRecovery = step.attempt > 1;
      const recoveryIndicator = isRecovery
        ? ' <span class="badge badge-recovery">↻ recovered</span>'
        : '';
      const tokenCost = `${step.cost.inputTokens + step.cost.outputTokens} tok ($${step.cost.costUsd.toFixed(4)})`;

      return `
      <tr${isRecovery ? ' class="recovery-row"' : ''}>
        <td>${step.sequence}</td>
        <td>${escapeHtml(step.nodeName)}${recoveryIndicator}</td>
        <td>${statusBadge(step.status)}</td>
        <td>${formatDuration(step)}</td>
        <td>${tokenCost}</td>
        <td>${step.attempt}</td>
      </tr>`;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Step Name</th>
          <th>Status</th>
          <th>Duration</th>
          <th>Tokens / Cost</th>
          <th>Attempt</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`;
}

export function runDetailPage(run: ExecutionRun, steps: Step[]): string {
  const meta = `
    <dl style="display:grid; grid-template-columns: auto 1fr; gap: 0.5rem 1rem; margin-bottom: 2rem;">
      <dt><strong>Run ID</strong></dt><dd>${escapeHtml(run.runId)}</dd>
      <dt><strong>Workflow</strong></dt><dd>${escapeHtml(run.config.name)}</dd>
      <dt><strong>Status</strong></dt><dd>${statusBadge(run.status)}</dd>
      <dt><strong>Total Cost</strong></dt><dd>$${run.totals.cost.toFixed(4)}</dd>
      <dt><strong>Total Steps</strong></dt><dd>${run.totals.steps}</dd>
      <dt><strong>Recoveries</strong></dt><dd>${run.totals.recoveryCount}</dd>
    </dl>`;

  const body = `
    <p><a href="/">← Back to runs</a></p>
    ${meta}
    <h2>Step Timeline</h2>
    ${stepTimeline(steps)}`;

  return layout(`Run: ${run.runId.slice(0, 8)}…`, body);
}

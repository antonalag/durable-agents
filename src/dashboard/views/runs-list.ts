import type { ExecutionRun } from '../../core/types.js';
import { layout } from './layout.js';

function statusBadge(status: string): string {
  const cls = `badge badge-${status}`;
  return `<span class="${cls}">${status}</span>`;
}

function formatDate(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

export function runsTable(runs: ExecutionRun[]): string {
  if (runs.length === 0) {
    return '<div class="empty-state"><p>No runs found. Start an agent workflow to see executions here.</p></div>';
  }

  const rows = runs
    .map(
      (run) => `
    <tr>
      <td><a href="/runs/${run.runId}">${run.runId.slice(0, 8)}…</a></td>
      <td>${run.config.name}</td>
      <td>${statusBadge(run.status)}</td>
      <td>$${run.totals.cost.toFixed(4)}</td>
      <td>${run.totals.steps}</td>
      <td>${formatDate(run.createdAt)}</td>
      <td>${formatDate(run.updatedAt)}</td>
    </tr>`,
    )
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Run ID</th>
          <th>Workflow</th>
          <th>Status</th>
          <th>Cost</th>
          <th>Steps</th>
          <th>Created</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody id="runs-body">
        ${rows}
      </tbody>
    </table>`;
}

export function runsListPage(runs: ExecutionRun[]): string {
  const body = `
    <div hx-ext="sse" sse-connect="/events" sse-swap="run:started,run:completed,run:failed">
      ${runsTable(runs)}
    </div>`;
  return layout('Runs', body);
}

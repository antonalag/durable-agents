import { escapeHtml } from '../escape.js';
import { layout } from './layout.js';

export function errorPage(status: number, message: string): string {
  const body = `
    <div class="empty-state">
      <h2>${status}</h2>
      <p>${escapeHtml(message)}</p>
      <p><a href="/">← Back to runs</a></p>
    </div>`;
  return layout(`Error ${status}`, body);
}

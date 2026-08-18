import { escapeHtml } from '../escape.js';

export function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — durable-agents</title>
  <script src="/static/htmx.min.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #f9fafb; color: #111; }
    h1 { margin-top: 0; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #e5e7eb; }
    th { background: #f3f4f6; font-weight: 600; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; }
    tr:hover { background: #f9fafb; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .badge { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .badge-running { background: #dbeafe; color: #1e40af; }
    .badge-completed { background: #d1fae5; color: #065f46; }
    .badge-failed { background: #fee2e2; color: #991b1b; }
    .badge-terminated { background: #fef3c7; color: #92400e; }
    .badge-pending { background: #e5e7eb; color: #374151; }
    .empty-state { text-align: center; padding: 3rem; color: #6b7280; }
    .recovery-row { background: #fffbeb; }
    .badge-recovery { background: #fef3c7; color: #92400e; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${body}
</body>
</html>`;
}

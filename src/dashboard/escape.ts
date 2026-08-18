const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};

const ESCAPE_RE = /[&<>"']/g;

export function escapeHtml(input: string): string {
  return input.replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch]);
}

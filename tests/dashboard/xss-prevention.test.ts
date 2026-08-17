import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../src/dashboard/escape.js';
import { runsListPage } from '../../src/dashboard/views/runs-list.js';
import { stepTimeline } from '../../src/dashboard/views/run-detail.js';
import { layout } from '../../src/dashboard/views/layout.js';
import type { ExecutionRun, Step } from '../../src/core/types.js';

describe('escapeHtml', () => {
  it('escapes all 5 dangerous characters', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#x27;');
  });

  it('leaves safe strings unchanged', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('runsListPage XSS prevention', () => {
  it('does not contain unescaped <script> tag when name is a script payload', () => {
    const xssRun: ExecutionRun = {
      runId: 'run-xss-001',
      status: 'completed',
      config: { name: '<script>alert(1)</script>' },
      metadata: {},
      totals: { cost: 0, tokens: 0, steps: 1, recoveryCount: 0 },
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      lastHeartbeat: new Date('2024-01-01'),
    };

    const html = runsListPage([xssRun]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('stepTimeline XSS prevention', () => {
  it('does not contain unescaped <img when nodeName is an event handler payload', () => {
    const xssStep: Step = {
      stepId: 'step-xss-1',
      runId: 'run-xss-001',
      nodeName: '<img onerror=alert(1)>',
      sequence: 0,
      status: 'completed',
      startedAt: new Date('2024-01-01T00:00:00Z'),
      completedAt: new Date('2024-01-01T00:00:01Z'),
      cost: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      attempt: 1,
    };

    const html = stepTimeline([xssStep]);
    expect(html).not.toContain('<img onerror=alert(1)>');
    expect(html).toContain('&lt;img onerror=alert(1)&gt;');
  });
});

describe('layout XSS prevention', () => {
  it('escapes HTML-dangerous characters in title', () => {
    const html = layout('<script>alert("xss")</script>', '<p>body</p>');
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('renders javascript: protocol as safe text in title context', () => {
    // javascript: is only dangerous in href/src attributes, not in text content.
    // escapeHtml targets HTML metacharacters. A title with quotes IS escaped.
    const html = layout("javascript:alert('xss')", '<p>body</p>');
    expect(html).not.toContain("javascript:alert('xss')");
    expect(html).toContain('javascript:alert(&#x27;xss&#x27;)');
  });
});

describe('multiple XSS payload classes', () => {
  it('script tag payloads are escaped in all views', () => {
    const payload = '<script>document.cookie</script>';
    expect(escapeHtml(payload)).not.toContain('<script>');
  });

  it('event handler payloads are escaped', () => {
    const payload = '<div onmouseover="steal()">';
    expect(escapeHtml(payload)).not.toContain('<div');
    expect(escapeHtml(payload)).toContain('&lt;div');
  });

  it('protocol handler payloads are escaped', () => {
    const payload = "javascript:void(document.cookie='x')";
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain("javascript:void(document.cookie='x')");
    expect(escaped).toContain('&#x27;');
  });

  it('nested/combined payloads are escaped', () => {
    const payload = '"><img src=x onerror=alert(1)>';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain('"');
    expect(escaped).not.toContain('<img');
    expect(escaped).toContain('&quot;');
    expect(escaped).toContain('&lt;img');
  });
});

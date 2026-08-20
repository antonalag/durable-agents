import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { statusBadge } from '../../src/dashboard/views/status-badge.js';

describe('Property 7: statusBadge output is injection-safe', () => {
  it('CSS class only contains allowlisted values for arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (status) => {
        const output = statusBadge(status);

        const classMatch = output.match(/class="([^"]+)"/);
        expect(classMatch).not.toBeNull();
        const classValue = classMatch![1];
        expect(classValue).toMatch(
          /^badge badge-(pending|running|completed|failed|stale|terminated|skipped|unknown)$/,
        );
      }),
      { numRuns: 200 },
    );
  });

  it('text content never contains raw HTML metacharacters', () => {
    fc.assert(
      fc.property(fc.string(), (status) => {
        const output = statusBadge(status);

        // Extract text between > and </span>
        const textMatch = output.match(/>([^<]*)<\/span>/);
        expect(textMatch).not.toBeNull();
        const textContent = textMatch![1];

        // Must not contain unescaped < or >
        expect(textContent).not.toContain('<');
        expect(textContent).not.toContain('>');
      }),
      { numRuns: 200 },
    );
  });

  it('known statuses produce their own CSS class', () => {
    const knownStatuses = [
      'pending',
      'running',
      'completed',
      'failed',
      'stale',
      'terminated',
      'skipped',
    ];
    for (const status of knownStatuses) {
      const output = statusBadge(status);
      expect(output).toContain(`badge-${status}`);
    }
  });

  it('malicious XSS payload is neutralized', () => {
    const payload = 'completed" onload="alert(1)';
    const output = statusBadge(payload);

    // Must use 'unknown' class (not allowlisted)
    expect(output).toContain('badge-unknown');
    // Quotes are escaped — attribute breakout is impossible
    expect(output).toContain('&quot;');
    // The CSS class attribute is not tainted by the payload
    expect(output).toMatch(/class="badge badge-unknown"/);
    // The raw unescaped quote must not appear in output (prevents attribute injection)
    expect(output).not.toMatch(/completed" onload="/);
  });

  it('empty string falls back to unknown', () => {
    const output = statusBadge('');
    expect(output).toContain('badge-unknown');
  });
});

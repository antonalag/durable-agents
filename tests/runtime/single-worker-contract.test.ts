import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');

/**
 * Single-Worker Contract Documentation Test
 *
 * v0.1.0 does NOT guarantee concurrent recovery safety. This is by design and
 * is documented as a known limitation. These tests ensure the documentation
 * clearly communicates the single-worker recovery contract so users are not
 * surprised by undefined behavior if they attempt multi-worker recovery.
 *
 * This is a documentation/contract test, NOT a concurrency regression test.
 */
describe('Single-worker contract documentation', () => {
  const conceptsPath = resolve(projectRoot, 'docs/concepts.md');
  const readmePath = resolve(projectRoot, 'README.md');

  it('docs/concepts.md documents single-worker recovery design', () => {
    const content = readFileSync(conceptsPath, 'utf-8');

    expect(content).toContain('single-worker recovery only');
    expect(content).toContain('concurrent recovery');
  });

  it('docs/concepts.md warns concurrent recovery is undefined behavior', () => {
    const content = readFileSync(conceptsPath, 'utf-8');

    expect(content).toContain(
      'treat concurrent recovery of the same run as undefined behavior',
    );
  });

  it('README.md Known Limitations section references single-worker model', () => {
    const content = readFileSync(readmePath, 'utf-8');

    expect(content).toContain('## Known Limitations');
    expect(content).toContain('Single-worker recovery');
    expect(content).toContain(
      'v0.1.0 assumes a single process performs recovery',
    );
  });
});

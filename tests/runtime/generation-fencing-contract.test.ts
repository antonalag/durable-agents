import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');

/**
 * Documentation/contract test for the concurrency model. Concurrent recovery of
 * the same run is made safe by single-database generation fencing, and the docs
 * must communicate that scope (single database, not distributed coordination)
 * so users are not surprised. This is a documentation test, not a concurrency
 * regression test.
 */
describe('concurrency-model documentation', () => {
  const conceptsPath = resolve(projectRoot, 'docs/concepts.md');
  const readmePath = resolve(projectRoot, 'README.md');

  it('docs/concepts.md documents generation fencing for concurrent recovery', () => {
    const content = readFileSync(conceptsPath, 'utf-8');

    expect(content).toContain('generation fencing');
    expect(content).toContain('recovery_generation');
    expect(content).toContain('concurrent recovery');
  });

  it('docs/concepts.md scopes fencing as single-database, not distributed', () => {
    const content = readFileSync(conceptsPath, 'utf-8');

    expect(content).toContain('single-database');
    expect(content).toContain('not** distributed leader election');
  });

  it('README.md Known Limitations describes single-database fencing', () => {
    const content = readFileSync(readmePath, 'utf-8');

    expect(content).toContain('## Known Limitations');
    expect(content).toContain('Single-database fencing');
    expect(content).toContain('not** distributed leader election');
  });
});

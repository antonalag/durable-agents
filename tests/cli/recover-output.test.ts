import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliSource = readFileSync(resolve(__dirname, '../../src/cli.ts'), 'utf-8');

describe('CLI recover output contract', () => {
  it('recover function outputs "Detected" for stale runs', () => {
    expect(cliSource).toContain('Detected');
  });

  it('recover function does NOT output "Recovering"', () => {
    expect(cliSource).not.toContain('Recovering');
  });

  it('help text says "does not re-execute"', () => {
    expect(cliSource).toContain('does not re-execute');
  });
});

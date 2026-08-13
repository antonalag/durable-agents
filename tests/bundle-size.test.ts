import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';

describe('Bundle Size Gate', () => {
  it('core bundle < 50KB minified', async () => {
    const result = await build({
      entryPoints: ['src/index.ts'],
      bundle: true,
      minify: true,
      format: 'esm',
      write: false,
      platform: 'node',
      target: 'node22',
      treeShaking: true,
      external: [
        'better-sqlite3',
        'pg',
        'superjson',
        'hono',
        'hono/*',
        '@hono/node-server',
        'node:*',
      ],
    });

    const output = result.outputFiles[0];
    const sizeBytes = output.contents.byteLength;
    const sizeKB = sizeBytes / 1024;

    console.log(`Core bundle size: ${sizeKB.toFixed(2)} KB (limit: 50 KB)`);

    expect(sizeBytes).toBeLessThan(50 * 1024);
  });
});

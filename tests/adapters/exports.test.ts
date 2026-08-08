import { describe, it, expect } from 'vitest';
import * as mainExports from '../../src/index.js';

describe('Subpath export isolation', () => {
  it('main entry exports idempotent utility', () => {
    expect(mainExports.idempotent).toBeDefined();
    expect(typeof mainExports.idempotent).toBe('function');
  });

  it('main entry exports adapter error types', () => {
    expect(mainExports.DurableAdapterError).toBeDefined();
    expect(mainExports.PeerDependencyError).toBeDefined();
  });

  it('main entry does NOT export langgraph adapter functions', () => {
    expect('createDurableMiddleware' in mainExports).toBe(false);
    expect('extractLangGraphTokens' in mainExports).toBe(false);
  });

  it('main entry does NOT export ai-sdk adapter functions', () => {
    expect('withDurability' in mainExports).toBe(false);
    expect('extractAiSdkTokens' in mainExports).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { DurableAdapterError, PeerDependencyError } from '../../src/adapters/errors.js';
import { assertPeerDependency } from '../../src/adapters/peer-check.js';

describe('DurableAdapterError', () => {
  it('has correct name, adapter, and code properties', () => {
    const err = new DurableAdapterError('something broke', 'langgraph', 'SOME_CODE');

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DurableAdapterError');
    expect(err.message).toBe('something broke');
    expect(err.adapter).toBe('langgraph');
    expect(err.code).toBe('SOME_CODE');
  });
});

describe('PeerDependencyError', () => {
  it('has correct name, adapter, code, and formatted message', () => {
    const err = new PeerDependencyError('@langchain/langgraph', '0.2.0', 'langgraph');

    expect(err).toBeInstanceOf(DurableAdapterError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PeerDependencyError');
    expect(err.adapter).toBe('langgraph');
    expect(err.code).toBe('PEER_DEPENDENCY_MISSING');
    expect(err.message).toBe(
      'durable-agents/langgraph requires "@langchain/langgraph" (>=0.2.0). Install it with: npm install @langchain/langgraph',
    );
  });

  it('message includes package name, version, and install command for ai-sdk', () => {
    const err = new PeerDependencyError('ai', '4.0.0', 'ai-sdk');

    expect(err.message).toContain('ai');
    expect(err.message).toContain('4.0.0');
    expect(err.message).toContain('npm install ai');
    expect(err.adapter).toBe('ai-sdk');
  });
});

describe('assertPeerDependency', () => {
  it('throws PeerDependencyError for a non-existent package', () => {
    expect(() =>
      assertPeerDependency('@nonexistent/package-xyz-12345', '1.0.0', 'langgraph'),
    ).toThrow(PeerDependencyError);

    try {
      assertPeerDependency('@nonexistent/package-xyz-12345', '1.0.0', 'langgraph');
    } catch (err) {
      expect(err).toBeInstanceOf(PeerDependencyError);
      expect((err as PeerDependencyError).adapter).toBe('langgraph');
      expect((err as PeerDependencyError).code).toBe('PEER_DEPENDENCY_MISSING');
      expect((err as PeerDependencyError).message).toContain('@nonexistent/package-xyz-12345');
      expect((err as PeerDependencyError).message).toContain('1.0.0');
    }
  });

  it('does not throw for an installed package', () => {
    expect(() => assertPeerDependency('vitest', '1.0.0', 'ai-sdk')).not.toThrow();
  });
});

export class DurableAdapterError extends Error {
  constructor(
    message: string,
    public readonly adapter: 'langgraph' | 'ai-sdk',
    public readonly code: string,
  ) {
    super(message);
    this.name = 'DurableAdapterError';
  }
}

export class PeerDependencyError extends DurableAdapterError {
  constructor(packageName: string, minVersion: string, adapter: 'langgraph' | 'ai-sdk') {
    super(
      `durable-agents/${adapter} requires "${packageName}" (>=${minVersion}). Install it with: npm install ${packageName}`,
      adapter,
      'PEER_DEPENDENCY_MISSING',
    );
    this.name = 'PeerDependencyError';
  }
}

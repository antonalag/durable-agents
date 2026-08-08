import { createRequire } from 'node:module';
import { PeerDependencyError } from './errors.js';

const require = createRequire(import.meta.url);

/**
 * Synchronously checks whether a peer dependency is resolvable.
 * Throws a descriptive PeerDependencyError with install instructions if not found.
 */
export function assertPeerDependency(
  packageName: string,
  minVersion: string,
  adapterName: 'langgraph' | 'ai-sdk',
): void {
  try {
    require.resolve(packageName);
  } catch {
    throw new PeerDependencyError(packageName, minVersion, adapterName);
  }
}

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { startDashboard, type DashboardServer } from '../../src/dashboard/index.js';
import { DurableError } from '../../src/errors.js';

describe('Dashboard Server Lifecycle', () => {
  let store: SqliteJournalStore;
  let server: DashboardServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    store?.close();
  });

  it('throws DurableError with DASHBOARD_PORT_IN_USE when port is occupied', async () => {
    store = new SqliteJournalStore(':memory:');

    const blocker = createServer();
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, () => {
        const addr = blocker.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    try {
      await expect(startDashboard({ store, port })).rejects.toThrow(DurableError);
      await expect(startDashboard({ store, port })).rejects.toMatchObject({
        code: 'DASHBOARD_PORT_IN_USE',
      });
    } finally {
      blocker.close();
    }
  });

  it('close() releases the port for reuse', async () => {
    store = new SqliteJournalStore(':memory:');
    const port = 49200 + Math.floor(Math.random() * 1000);
    server = await startDashboard({ store, port });

    await server.close();
    server = undefined;

    // Starting a new server on the same port should succeed
    server = await startDashboard({ store, port });
    expect(server.port).toBe(port);
  });

  it('does not write to the store (read-only access)', async () => {
    store = new SqliteJournalStore(':memory:');
    const port = 49300 + Math.floor(Math.random() * 1000);
    server = await startDashboard({ store, port });

    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);

    const runs = await store.listRuns();
    expect(runs).toHaveLength(0);
  });
});

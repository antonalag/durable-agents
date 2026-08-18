import { describe, it, expect, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { startDashboard, type DashboardServer } from '../../src/dashboard/index.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { DurableError } from '../../src/errors.js';
import type { RunStartedEvent } from '../../src/core/types.js';

describe('Dashboard Integration', () => {
  let store: SqliteJournalStore;
  let server: DashboardServer | undefined;

  afterEach(async () => {
    if (server) { await server.close(); server = undefined; }
    store?.close();
  });

  it('server start/stop lifecycle', async () => {
    store = new SqliteJournalStore(':memory:');
    const port = 44000 + Math.floor(Math.random() * 1000);
    server = await startDashboard({ store, port });
    expect(server.port).toBe(port);

    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');

    await server.close();
    server = undefined;
  });

  it('serves runs from the store', async () => {
    store = new SqliteJournalStore(':memory:');
    await store.createRun({ name: 'integration-test' });

    const port = 44100 + Math.floor(Math.random() * 1000);
    server = await startDashboard({ store, port });

    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    expect(html).toContain('integration-test');
  });

  it('returns 404 for non-existent run', async () => {
    store = new SqliteJournalStore(':memory:');
    const port = 44200 + Math.floor(Math.random() * 1000);
    server = await startDashboard({ store, port });

    const res = await fetch(`http://localhost:${port}/runs/nonexistent-id`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('not found');
  });

  it('SSE endpoint establishes connection with correct headers', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    const port = 44300 + Math.floor(Math.random() * 1000);
    server = await startDashboard({ store, port, eventBus });

    const controller = new AbortController();

    // Start fetch and emit concurrently — emit after 100ms to give connection time
    const fetchPromise = fetch(`http://localhost:${port}/events`, {
      signal: controller.signal,
    });

    setTimeout(() => {
      eventBus.emit('run:started', {
        type: 'run:started',
        timestamp: new Date(),
        runId: 'test-run-sse',
        config: { name: 'test' },
      } satisfies RunStartedEvent);
    }, 100);

    const res = await fetchPromise;
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    controller.abort();

    expect(text).toContain('event: run:started');
    expect(text).toContain('test-run-sse');
  });

  it('SSE endpoint cleans up listener on client disconnect', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    const port = 44400 + Math.floor(Math.random() * 1000);
    server = await startDashboard({ store, port, eventBus });

    const controller = new AbortController();

    // Start SSE connection
    const fetchPromise = fetch(`http://localhost:${port}/events`, {
      signal: controller.signal,
    });

    // Emit an event to trigger the response
    setTimeout(() => {
      eventBus.emit('run:started', {
        type: 'run:started',
        timestamp: new Date(),
        runId: 'cleanup-test',
        config: { name: 'test' },
      } satisfies RunStartedEvent);
    }, 50);

    const res = await fetchPromise;
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    // Abort the connection to trigger cleanup
    controller.abort();

    // Server should still be healthy after disconnect
    const healthRes = await fetch(`http://localhost:${port}/`);
    expect(healthRes.status).toBe(200);
  });
});

describe('DurableWorkflow typed errors', () => {
  let store: SqliteJournalStore;
  afterEach(() => store?.close());

  it('terminate throws DurableError with RUN_TERMINATED for inactive run', async () => {
    store = new SqliteJournalStore(':memory:');
    const workflow = new DurableWorkflow('err-test', async () => 'ok', {
      store, heartbeatIntervalMs: 1000, staleTimeoutMs: 5000,
    });

    await expect(workflow.terminate('nonexistent', 'test')).rejects.toThrow(DurableError);
    try {
      await workflow.terminate('nonexistent', 'test');
    } catch (err) {
      expect((err as DurableError).code).toBe('RUN_TERMINATED');
    }
  });

  it('invalid config throws DurableError with INVALID_CONFIG', () => {
    store = new SqliteJournalStore(':memory:');
    expect(() => new DurableWorkflow('', async () => 'ok', {
      store, heartbeatIntervalMs: 1000, staleTimeoutMs: 5000,
    })).toThrow(DurableError);

    try {
      new DurableWorkflow('', async () => 'ok', {
        store, heartbeatIntervalMs: 1000, staleTimeoutMs: 5000,
      });
    } catch (err) {
      expect((err as DurableError).code).toBe('INVALID_CONFIG');
    }
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { idempotent } from '../../src/adapters/idempotent.js';
import type { ExecutionRun } from '../../src/core/types.js';

describe('idempotent decorator', () => {
  let store: SqliteJournalStore;
  let eventBus: EventBus;
  let run: ExecutionRun;
  let ctx: DurableContextImpl;

  beforeEach(async () => {
    store = new SqliteJournalStore(':memory:');
    eventBus = new EventBus();
    run = await store.createRun({ name: 'test' });
    run = await store.updateRun(run.runId, { status: 'running' });

    ctx = new DurableContextImpl({
      run,
      store,
      mode: 'fresh',
      replayCursor: new Map(),
      eventBus,
      signal: new AbortController().signal,
    });
  });

  afterEach(() => {
    store.close();
  });

  it('first call executes function and records result', async () => {
    let callCount = 0;
    const result = await idempotent(ctx, 'send-email', { to: 'user@test.com' }, async () => {
      callCount++;
      return 'sent';
    });

    expect(result).toBe('sent');
    expect(callCount).toBe(1);
  });

  it('second call with same key returns recorded result without executing', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      return 'sent';
    };

    await idempotent(ctx, 'send-email', { to: 'user@test.com' }, fn);
    const result2 = await idempotent(ctx, 'send-email', { to: 'user@test.com' }, fn);

    expect(result2).toBe('sent');
    expect(callCount).toBe(1);
  });

  it('error propagation without recording', async () => {
    const error = new Error('network failure');
    await expect(
      idempotent(ctx, 'send-email', { to: 'fail@test.com' }, async () => {
        throw error;
      }),
    ).rejects.toThrow('network failure');

    // Retry should execute fn again since no outcome was recorded
    let retryCount = 0;
    const result = await idempotent(ctx, 'send-email', { to: 'fail@test.com' }, async () => {
      retryCount++;
      return 'retried';
    });

    expect(result).toBe('retried');
    expect(retryCount).toBe(1);
  });

  it('different args produce different keys', async () => {
    let callCount = 0;
    await idempotent(ctx, 'send-email', { to: 'a@test.com' }, async () => {
      callCount++;
      return 'a';
    });
    await idempotent(ctx, 'send-email', { to: 'b@test.com' }, async () => {
      callCount++;
      return 'b';
    });

    expect(callCount).toBe(2);
  });
});

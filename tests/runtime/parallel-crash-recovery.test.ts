import { describe, it, expect, afterEach } from 'vitest';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { RecoveryEngine } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { JournalStore } from '../../src/stores/interface.js';
import type { OutcomeRecord } from '../../src/core/types.js';
import type { DurableContextImpl } from '../../src/runtime/context.js';
import type { WorkflowFn } from '../../src/runtime/workflow.js';

/**
 * Simulates a crash inside a parallel group: one branch persists its outcome,
 * a chosen branch loses its outcome in the fn()->recordOutcome window, and the
 * process is modelled as failing. Recovery then runs the same workflow and we
 * observe which branches re-execute.
 */
class ParallelCrashStore implements JournalStore {
  /** operationKeys whose recordOutcome must throw once, simulating a lost write. */
  readonly dropKeys = new Set<string>();
  /** Branch node names that executed fn(), recorded by the test workflow. */
  readonly executed: string[] = [];

  constructor(private readonly inner: SqliteJournalStore) {}

  createRun = (...a: Parameters<JournalStore['createRun']>) => this.inner.createRun(...a);
  getRun = (...a: Parameters<JournalStore['getRun']>) => this.inner.getRun(...a);
  updateRun = (...a: Parameters<JournalStore['updateRun']>) => this.inner.updateRun(...a);
  listRuns = (...a: Parameters<JournalStore['listRuns']>) => this.inner.listRuns(...a);
  deleteRun = (...a: Parameters<JournalStore['deleteRun']>) => this.inner.deleteRun(...a);
  createStep = (...a: Parameters<JournalStore['createStep']>) => this.inner.createStep(...a);
  getStep = (...a: Parameters<JournalStore['getStep']>) => this.inner.getStep(...a);
  updateStep = (...a: Parameters<JournalStore['updateStep']>) => this.inner.updateStep(...a);
  listSteps = (...a: Parameters<JournalStore['listSteps']>) => this.inner.listSteps(...a);
  getOutcome = (...a: Parameters<JournalStore['getOutcome']>) => this.inner.getOutcome(...a);
  getOutcomeByKey = (...a: Parameters<JournalStore['getOutcomeByKey']>) =>
    this.inner.getOutcomeByKey(...a);
  listOutcomes = (...a: Parameters<JournalStore['listOutcomes']>) =>
    this.inner.listOutcomes(...a);
  updateHeartbeat = (...a: Parameters<JournalStore['updateHeartbeat']>) =>
    this.inner.updateHeartbeat(...a);
  findStaleRuns = (...a: Parameters<JournalStore['findStaleRuns']>) =>
    this.inner.findStaleRuns(...a);
  claimRunForRecovery = (...a: Parameters<JournalStore['claimRunForRecovery']>) =>
    this.inner.claimRunForRecovery(...a);
  deleteRunsOlderThan = (...a: Parameters<JournalStore['deleteRunsOlderThan']>) =>
    this.inner.deleteRunsOlderThan(...a);

  recordOutcome(
    outcome: OutcomeRecord,
    expectedGeneration: number,
  ): Promise<OutcomeRecord> {
    if (this.dropKeys.has(outcome.operationKey)) {
      this.dropKeys.delete(outcome.operationKey);
      return Promise.reject(
        new Error(`Simulated lost write for ${outcome.operationKey}`),
      );
    }
    return this.inner.recordOutcome(outcome, expectedGeneration);
  }
}

describe('crash inside a parallel group then recover', () => {
  let inner: SqliteJournalStore;

  afterEach(() => {
    inner.close();
  });

  it('re-executes only the branch whose outcome was lost and keeps the persisted sibling', async () => {
    inner = new SqliteJournalStore(':memory:');
    const store = new ParallelCrashStore(inner);
    const eventBus = new EventBus();

    const build = (tag: string): WorkflowFn<string, string[]> =>
      async (ctx: DurableContextImpl) =>
        ctx.parallel([
          {
            name: 'a',
            fn: () => {
              store.executed.push(`${tag}:a`);
              return 'A';
            },
          },
          {
            name: 'b',
            fn: () => {
              store.executed.push(`${tag}:b`);
              return 'B';
            },
          },
        ]);

    // Branch "b" sits at sequence 1; drop its outcome write once the run exists.
    eventBus.on('run:started', (e) => {
      store.dropKeys.add(computeOperationKey(e.runId, 'b', 1));
    });

    const workflow = new DurableWorkflow(
      'parallel-crash',
      build('run1'),
      { store: store as unknown as JournalStore, eventBus, heartbeatIntervalMs: 5_000, staleTimeoutMs: 30_000 },
    );

    // First run: branch b's outcome is lost, so parallel() rejects and the run fails.
    await expect(workflow.run('input')).rejects.toThrow('Simulated lost write');

    // Branch a persisted; branch b did not.
    const failed = await inner.listRuns({ status: 'failed' });
    expect(failed).toHaveLength(1);
    const runId = failed[0].runId;

    const aKey = computeOperationKey(runId, 'a', 0);
    const bKey = computeOperationKey(runId, 'b', 1);
    expect(await inner.getOutcomeByKey(aKey)).not.toBeNull();
    expect(await inner.getOutcomeByKey(bKey)).toBeNull();

    const firstRunExecuted = [...store.executed];
    expect(firstRunExecuted).toContain('run1:a');
    expect(firstRunExecuted).toContain('run1:b');

    // Recovery: a is replayed from cache (fn not called), b re-executes.
    store.executed.length = 0;
    const engine = new RecoveryEngine(store as unknown as JournalStore, eventBus, 30_000);
    const result = await engine.recover(runId, build('run2'), 'input', 0);

    expect(result).toEqual(['A', 'B']);
    expect(store.executed).toEqual(['run2:b']);
    expect(store.executed).not.toContain('run2:a');

    // Final state is consistent: run completed, both outcomes present.
    const recovered = await inner.getRun(runId);
    expect(recovered!.status).toBe('completed');
    expect(await inner.getOutcomeByKey(aKey)).not.toBeNull();
    expect(await inner.getOutcomeByKey(bKey)).not.toBeNull();
  });
});

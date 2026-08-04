import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import type { JournalStore } from '../../src/stores/interface.js';
import type { RunConfig, Step, OutcomeRecord } from '../../src/core/types.js';

type StoreFactory = () => Promise<{ store: JournalStore; teardown: () => Promise<void> }>;

function makeRunConfig(overrides?: Partial<RunConfig>): RunConfig {
  return { name: `test-workflow-${randomUUID().slice(0, 8)}`, ...overrides };
}

function makeStep(runId: string, sequence: number): Omit<Step, 'completedAt'> {
  return {
    stepId: randomUUID(),
    runId,
    nodeName: `step-${sequence}`,
    sequence,
    status: 'pending',
    startedAt: new Date(),
    inputStateHash: undefined,
    cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    attempt: 1,
  };
}

function makeOutcome(stepId: string): OutcomeRecord {
  return {
    outcomeId: randomUUID(),
    stepId,
    operationType: 'llm_call',
    operationKey: randomUUID(),
    result: { response: 'test result', data: [1, 2, 3] },
    tokens: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
    durationMs: 150,
    recordedAt: new Date(),
  };
}

export function journalStoreSuite(name: string, factory: StoreFactory): void {
  describe(`JournalStore: ${name}`, () => {
    let store: JournalStore;
    let teardown: () => Promise<void>;

    beforeEach(async () => {
      const ctx = await factory();
      store = ctx.store;
      teardown = ctx.teardown;
    });

    afterEach(async () => {
      await teardown();
    });

    describe('runs', () => {
      it('createRun returns a valid run with pending status and zeroed totals', async () => {
        const config = makeRunConfig();
        const run = await store.createRun(config);
        expect(run.runId).toBeTruthy();
        expect(run.status).toBe('pending');
        expect(run.config.name).toBe(config.name);
        expect(run.totals).toEqual({ cost: 0, tokens: 0, steps: 0, recoveryCount: 0 });
        expect(run.createdAt).toBeInstanceOf(Date);
        expect(run.updatedAt).toBeInstanceOf(Date);
        expect(run.lastHeartbeat).toBeInstanceOf(Date);
      });

      it('getRun returns null for non-existent runId', async () => {
        const result = await store.getRun('non-existent');
        expect(result).toBeNull();
      });

      it('getRun returns the created run', async () => {
        const run = await store.createRun(makeRunConfig());
        const retrieved = await store.getRun(run.runId);
        expect(retrieved).not.toBeNull();
        expect(retrieved!.runId).toBe(run.runId);
        expect(retrieved!.config.name).toBe(run.config.name);
      });

      it('updateRun updates status and bumps updatedAt', async () => {
        const run = await store.createRun(makeRunConfig());
        const before = run.updatedAt;
        await new Promise((r) => setTimeout(r, 10));
        const updated = await store.updateRun(run.runId, { status: 'running' });
        expect(updated.status).toBe('running');
        expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(updated.runId).toBe(run.runId);
        expect(updated.config.name).toBe(run.config.name);
      });

      it('updateRun throws for non-existent run', async () => {
        await expect(store.updateRun('nope', { status: 'running' })).rejects.toThrow();
      });

      it('listRuns returns runs ordered by createdAt descending', async () => {
        const r1 = await store.createRun(makeRunConfig());
        await new Promise((r) => setTimeout(r, 10));
        const r2 = await store.createRun(makeRunConfig());
        await new Promise((r) => setTimeout(r, 10));
        const r3 = await store.createRun(makeRunConfig());

        const runs = await store.listRuns();
        expect(runs.length).toBeGreaterThanOrEqual(3);
        expect(runs[0].runId).toBe(r3.runId);
        expect(runs[1].runId).toBe(r2.runId);
        expect(runs[2].runId).toBe(r1.runId);
      });

      it('listRuns filters by status', async () => {
        const r1 = await store.createRun(makeRunConfig());
        await store.updateRun(r1.runId, { status: 'running' });
        await store.createRun(makeRunConfig());

        const running = await store.listRuns({ status: 'running' });
        expect(running.length).toBe(1);
        expect(running[0].runId).toBe(r1.runId);
      });

      it('listRuns respects limit and offset', async () => {
        await store.createRun(makeRunConfig());
        await new Promise((r) => setTimeout(r, 10));
        await store.createRun(makeRunConfig());
        await new Promise((r) => setTimeout(r, 10));
        await store.createRun(makeRunConfig());

        const limited = await store.listRuns({ limit: 2 });
        expect(limited.length).toBe(2);

        const offset = await store.listRuns({ limit: 2, offset: 1 });
        expect(offset.length).toBe(2);
      });

      it('deleteRun cascades to steps and outcomes', async () => {
        const run = await store.createRun(makeRunConfig());
        const step = await store.createStep(makeStep(run.runId, 0));
        await store.recordOutcome(makeOutcome(step.stepId));

        await store.deleteRun(run.runId);

        expect(await store.getRun(run.runId)).toBeNull();
        expect(await store.listSteps(run.runId)).toEqual([]);
        expect(await store.listOutcomes(step.stepId)).toEqual([]);
      });
    });

    describe('steps', () => {
      it('createStep and getStep', async () => {
        const run = await store.createRun(makeRunConfig());
        const stepInput = makeStep(run.runId, 0);
        const step = await store.createStep(stepInput);
        expect(step.stepId).toBe(stepInput.stepId);
        expect(step.completedAt).toBeUndefined();

        const retrieved = await store.getStep(step.stepId);
        expect(retrieved).not.toBeNull();
        expect(retrieved!.stepId).toBe(step.stepId);
      });

      it('getStep returns null for non-existent', async () => {
        expect(await store.getStep('nope')).toBeNull();
      });

      it('updateStep updates fields', async () => {
        const run = await store.createRun(makeRunConfig());
        const step = await store.createStep(makeStep(run.runId, 0));
        const now = new Date();
        const updated = await store.updateStep(step.stepId, {
          status: 'completed',
          completedAt: now,
          cost: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
          attempt: 2,
        });
        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.cost.inputTokens).toBe(100);
        expect(updated.attempt).toBe(2);
      });

      it('listSteps returns steps ordered by sequence ascending', async () => {
        const run = await store.createRun(makeRunConfig());
        await store.createStep(makeStep(run.runId, 2));
        await store.createStep(makeStep(run.runId, 0));
        await store.createStep(makeStep(run.runId, 1));

        const steps = await store.listSteps(run.runId);
        expect(steps.map((s) => s.sequence)).toEqual([0, 1, 2]);
      });
    });

    describe('outcomes', () => {
      it('recordOutcome and getOutcome', async () => {
        const run = await store.createRun(makeRunConfig());
        const step = await store.createStep(makeStep(run.runId, 0));
        const outcome = makeOutcome(step.stepId);
        const recorded = await store.recordOutcome(outcome);
        expect(recorded.outcomeId).toBe(outcome.outcomeId);

        const retrieved = await store.getOutcome(outcome.outcomeId);
        expect(retrieved).not.toBeNull();
        expect(retrieved!.operationKey).toBe(outcome.operationKey);
      });

      it('getOutcomeByKey returns outcome by operation key', async () => {
        const run = await store.createRun(makeRunConfig());
        const step = await store.createStep(makeStep(run.runId, 0));
        const outcome = makeOutcome(step.stepId);
        await store.recordOutcome(outcome);

        const byKey = await store.getOutcomeByKey(outcome.operationKey);
        expect(byKey).not.toBeNull();
        expect(byKey!.outcomeId).toBe(outcome.outcomeId);
      });

      it('getOutcomeByKey returns null for non-existent key', async () => {
        expect(await store.getOutcomeByKey('no-such-key')).toBeNull();
      });

      it('recordOutcome with duplicate operation_key throws', async () => {
        const run = await store.createRun(makeRunConfig());
        const step = await store.createStep(makeStep(run.runId, 0));
        const outcome = makeOutcome(step.stepId);
        await store.recordOutcome(outcome);

        const duplicate = { ...outcome, outcomeId: randomUUID() };
        await expect(store.recordOutcome(duplicate)).rejects.toThrow();
      });

      it('listOutcomes returns outcomes for a step', async () => {
        const run = await store.createRun(makeRunConfig());
        const step = await store.createStep(makeStep(run.runId, 0));
        await store.recordOutcome(makeOutcome(step.stepId));
        await store.recordOutcome(makeOutcome(step.stepId));

        const outcomes = await store.listOutcomes(step.stepId);
        expect(outcomes.length).toBe(2);
      });
    });

    describe('heartbeat and stale detection', () => {
      it('updateHeartbeat changes lastHeartbeat', async () => {
        const run = await store.createRun(makeRunConfig());
        const before = run.lastHeartbeat;
        await new Promise((r) => setTimeout(r, 10));
        await store.updateHeartbeat(run.runId);
        const updated = await store.getRun(run.runId);
        expect(updated!.lastHeartbeat.getTime()).toBeGreaterThan(before.getTime());
      });

      it('findStaleRuns returns only running runs with expired heartbeat', async () => {
        const r1 = await store.createRun(makeRunConfig());
        await store.updateRun(r1.runId, { status: 'running' });

        const r2 = await store.createRun(makeRunConfig());
        await store.updateRun(r2.runId, { status: 'running' });

        const r3 = await store.createRun(makeRunConfig());

        // Small delay so heartbeats are strictly in the past
        await new Promise((r) => setTimeout(r, 5));

        // With a timeout of 0ms, everything with 'running' status is stale
        const stale = await store.findStaleRuns(0);
        const staleIds = stale.map((r) => r.runId);
        expect(staleIds).toContain(r1.runId);
        expect(staleIds).toContain(r2.runId);
        expect(staleIds).not.toContain(r3.runId);
      });
    });

    describe('deleteRunsOlderThan', () => {
      it('deletes old runs and returns count', async () => {
        await store.createRun(makeRunConfig());
        await store.createRun(makeRunConfig());
        await new Promise((r) => setTimeout(r, 50));

        const deleted = await store.deleteRunsOlderThan(25);
        expect(deleted).toBe(2);
      });

      it('returns 0 when no runs qualify', async () => {
        await store.createRun(makeRunConfig());
        const deleted = await store.deleteRunsOlderThan(3600000);
        expect(deleted).toBe(0);
      });

      it('cascades delete to steps and outcomes', async () => {
        const run = await store.createRun(makeRunConfig());
        const step = await store.createStep(makeStep(run.runId, 0));
        await store.recordOutcome(makeOutcome(step.stepId));

        await new Promise((r) => setTimeout(r, 50));
        await store.deleteRunsOlderThan(25);

        expect(await store.getRun(run.runId)).toBeNull();
        expect(await store.listSteps(run.runId)).toEqual([]);
        expect(await store.listOutcomes(step.stepId)).toEqual([]);
      });
    });

    describe('properties', () => {
      it('createRun always produces valid initial state', async () => {
        await fc.assert(
          fc.asyncProperty(fc.string({ minLength: 1 }), async (name) => {
            const run = await store.createRun({ name });
            expect(run.runId).toBeTruthy();
            expect(run.status).toBe('pending');
            expect(run.totals).toEqual({ cost: 0, tokens: 0, steps: 0, recoveryCount: 0 });
            expect(run.createdAt).toBeInstanceOf(Date);
            await store.deleteRun(run.runId);
          }),
          { numRuns: 20 },
        );
      });

      it('updateRun preserves runId, config, and createdAt', async () => {
        const run = await store.createRun(makeRunConfig());
        const updated = await store.updateRun(run.runId, {
          status: 'running',
          metadata: { updated: true },
          totals: { cost: 1, tokens: 100, steps: 5, recoveryCount: 1 },
        });
        expect(updated.runId).toBe(run.runId);
        expect(updated.config.name).toBe(run.config.name);
        expect(updated.createdAt.getTime()).toBe(run.createdAt.getTime());
        expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(run.updatedAt.getTime());
      });

      it('listRuns always returns createdAt in non-increasing order', async () => {
        for (let i = 0; i < 5; i++) {
          await store.createRun(makeRunConfig());
          await new Promise((r) => setTimeout(r, 5));
        }
        const runs = await store.listRuns();
        for (let i = 1; i < runs.length; i++) {
          expect(runs[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(
            runs[i].createdAt.getTime(),
          );
        }
      });

      it('cascade delete removes all steps and outcomes', async () => {
        const run = await store.createRun(makeRunConfig());
        const step = await store.createStep(makeStep(run.runId, 0));
        const outcome = makeOutcome(step.stepId);
        await store.recordOutcome(outcome);

        await store.deleteRun(run.runId);

        expect(await store.getRun(run.runId)).toBeNull();
        expect(await store.getStep(step.stepId)).toBeNull();
        expect(await store.getOutcome(outcome.outcomeId)).toBeNull();
        expect(await store.getOutcomeByKey(outcome.operationKey)).toBeNull();
      });

      it('listSteps always returns sequence in strictly increasing order', async () => {
        const run = await store.createRun(makeRunConfig());
        const sequences = [3, 1, 4, 0, 2];
        for (const seq of sequences) {
          await store.createStep(makeStep(run.runId, seq));
        }
        const steps = await store.listSteps(run.runId);
        for (let i = 1; i < steps.length; i++) {
          expect(steps[i].sequence).toBeGreaterThan(steps[i - 1].sequence);
        }
      });

      it('recorded outcome can be retrieved by key with matching fields', async () => {
        const run = await store.createRun(makeRunConfig());
        const step = await store.createStep(makeStep(run.runId, 0));
        const outcome = makeOutcome(step.stepId);
        await store.recordOutcome(outcome);

        const retrieved = await store.getOutcomeByKey(outcome.operationKey);
        expect(retrieved).not.toBeNull();
        expect(retrieved!.outcomeId).toBe(outcome.outcomeId);
        expect(retrieved!.operationType).toBe(outcome.operationType);
        expect(retrieved!.operationKey).toBe(outcome.operationKey);
        expect(retrieved!.durationMs).toBe(outcome.durationMs);
      });

      it('findStaleRuns only returns running runs with expired heartbeats', async () => {
        const running = await store.createRun(makeRunConfig());
        await store.updateRun(running.runId, { status: 'running' });

        const completed = await store.createRun(makeRunConfig());
        await store.updateRun(completed.runId, { status: 'completed' });

        const pending = await store.createRun(makeRunConfig());

        // Small delay so heartbeats are strictly in the past relative to findStaleRuns threshold
        await new Promise((r) => setTimeout(r, 5));

        const stale = await store.findStaleRuns(0);
        const ids = stale.map((r) => r.runId);
        expect(ids).toContain(running.runId);
        expect(ids).not.toContain(completed.runId);
        expect(ids).not.toContain(pending.runId);
      });

      // Property 12: TTL delete correctness
      it('deleteRunsOlderThan deletes exactly the runs older than threshold', async () => {
        const oldRun = await store.createRun(makeRunConfig());
        const oldStep = await store.createStep(makeStep(oldRun.runId, 0));
        await store.recordOutcome(makeOutcome(oldStep.stepId));

        await new Promise((r) => setTimeout(r, 50));

        const freshRun = await store.createRun(makeRunConfig());

        // Delete runs older than 25ms — only oldRun should be deleted
        const deleted = await store.deleteRunsOlderThan(25);
        expect(deleted).toBe(1);

        // Old run and its data are gone
        expect(await store.getRun(oldRun.runId)).toBeNull();
        expect(await store.listSteps(oldRun.runId)).toEqual([]);
        expect(await store.listOutcomes(oldStep.stepId)).toEqual([]);

        // Fresh run still exists
        expect(await store.getRun(freshRun.runId)).not.toBeNull();
      });

      // Property 13: Store-level type fidelity round-trip
      it('stored and retrieved domain objects preserve Date types', async () => {
        const config = makeRunConfig();
        const run = await store.createRun(config);

        const retrieved = await store.getRun(run.runId);
        expect(retrieved!.createdAt).toBeInstanceOf(Date);
        expect(retrieved!.updatedAt).toBeInstanceOf(Date);
        expect(retrieved!.lastHeartbeat).toBeInstanceOf(Date);

        const step = await store.createStep(makeStep(run.runId, 0));
        const retrievedStep = await store.getStep(step.stepId);
        expect(retrievedStep!.startedAt).toBeInstanceOf(Date);

        const now = new Date();
        await store.updateStep(step.stepId, { status: 'completed', completedAt: now });
        const completedStep = await store.getStep(step.stepId);
        expect(completedStep!.completedAt).toBeInstanceOf(Date);
        expect(completedStep!.completedAt!.getTime()).toBe(now.getTime());

        const outcome = makeOutcome(step.stepId);
        await store.recordOutcome(outcome);
        const retrievedOutcome = await store.getOutcome(outcome.outcomeId);
        expect(retrievedOutcome!.recordedAt).toBeInstanceOf(Date);
        expect(retrievedOutcome!.recordedAt.getTime()).toBe(outcome.recordedAt.getTime());
      });
    });
  });
}

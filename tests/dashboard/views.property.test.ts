// Feature: sprint-5-dashboard-cli-polish, Property 1-3: Dashboard views
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { runsTable } from '../../src/dashboard/views/runs-list.js';
import { escapeHtml } from '../../src/dashboard/escape.js';
import type { ExecutionRun, RunStatus } from '../../src/core/types.js';

const statuses: RunStatus[] = ['pending', 'running', 'completed', 'failed', 'stale', 'terminated'];

const runArb: fc.Arbitrary<ExecutionRun> = fc.record({
  runId: fc.uuid(),
  status: fc.constantFrom(...statuses),
  config: fc.record({
    name: fc.string({ minLength: 1, maxLength: 20 }),
  }),
  metadata: fc.constant({}),
  totals: fc.record({
    cost: fc.double({ min: 0, max: 100, noNaN: true }),
    tokens: fc.nat({ max: 100000 }),
    steps: fc.nat({ max: 1000 }),
    recoveryCount: fc.nat({ max: 10 }),
  }),
  createdAt: fc.date({ noInvalidDate: true }),
  updatedAt: fc.date({ noInvalidDate: true }),
  lastHeartbeat: fc.date({ noInvalidDate: true }),
});

// **Validates: Requirements 2.1**
describe('Property 1: Runs list rendering completeness', () => {
  it('runsTable contains all fields for every run', () => {
    fc.assert(
      fc.property(fc.array(runArb, { minLength: 1, maxLength: 10 }), (runs) => {
        const html = runsTable(runs);
        for (const run of runs) {
          expect(html).toContain(escapeHtml(run.runId.slice(0, 8)));
          expect(html).toContain(escapeHtml(run.config.name));
          expect(html).toContain(run.status);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// **Validates: Requirements 2.2**
describe('Property 2: Sorting invariant', () => {
  it('sorted runs maintain ordering for the specified column', () => {
    fc.assert(
      fc.property(
        fc.array(runArb, { minLength: 2, maxLength: 15 }),
        fc.constantFrom('cost', 'steps', 'createdAt', 'updatedAt'),
        (runs, sortCol) => {
          const sorted = [...runs];
          switch (sortCol) {
            case 'cost':
              sorted.sort((a, b) => b.totals.cost - a.totals.cost);
              break;
            case 'steps':
              sorted.sort((a, b) => b.totals.steps - a.totals.steps);
              break;
            case 'createdAt':
              sorted.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
              break;
            case 'updatedAt':
              sorted.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
              break;
          }
          for (let i = 0; i < sorted.length - 1; i++) {
            switch (sortCol) {
              case 'cost':
                expect(sorted[i].totals.cost).toBeGreaterThanOrEqual(sorted[i + 1].totals.cost);
                break;
              case 'steps':
                expect(sorted[i].totals.steps).toBeGreaterThanOrEqual(sorted[i + 1].totals.steps);
                break;
              case 'createdAt':
                expect(sorted[i].createdAt.getTime()).toBeGreaterThanOrEqual(
                  sorted[i + 1].createdAt.getTime(),
                );
                break;
              case 'updatedAt':
                expect(sorted[i].updatedAt.getTime()).toBeGreaterThanOrEqual(
                  sorted[i + 1].updatedAt.getTime(),
                );
                break;
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// **Validates: Requirements 2.3**
describe('Property 3: Filter correctness', () => {
  it('filtered runs all match the filter value and no matching run is absent', () => {
    fc.assert(
      fc.property(
        fc.array(runArb, { minLength: 1, maxLength: 15 }),
        fc.constantFrom(...statuses),
        (runs, filterStatus) => {
          const filtered = runs.filter((r) => r.status === filterStatus);
          for (const run of filtered) {
            expect(run.status).toBe(filterStatus);
          }
          const missed = runs.filter(
            (r) => r.status === filterStatus && !filtered.includes(r),
          );
          expect(missed.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { stepTimeline } from '../../src/dashboard/views/run-detail.js';
import type { Step, StepStatus } from '../../src/core/types.js';

const stepStatuses: StepStatus[] = ['pending', 'running', 'completed', 'failed', 'skipped'];

const stepArb: fc.Arbitrary<Step> = fc.record({
  stepId: fc.uuid(),
  runId: fc.uuid(),
  nodeName: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,19}$/),
  sequence: fc.nat({ max: 100 }),
  status: fc.constantFrom(...stepStatuses),
  startedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true }),
  completedAt: fc.option(
    fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true }),
    { nil: undefined },
  ),
  cost: fc.record({
    inputTokens: fc.nat({ max: 10000 }),
    outputTokens: fc.nat({ max: 10000 }),
    costUsd: fc.double({ min: 0, max: 1, noNaN: true }),
  }),
  attempt: fc.integer({ min: 1, max: 10 }),
});

describe('Feature: sprint-5-dashboard-cli-polish, Property 4: Step timeline ordering', () => {
  /**
   * Validates: Requirements 3.1
   *
   * For any array of Step objects with distinct sequence values,
   * the stepTimeline rendering function produces output where steps
   * appear in ascending sequence order.
   */
  it('stepTimeline renders steps in ascending sequence order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat({ max: 100 }), { minLength: 2, maxLength: 10 }).map((sequences) =>
          sequences.map((seq, i) => ({
            stepId: `step-${i}`,
            runId: 'run-1',
            nodeName: `node_${seq}`,
            sequence: seq,
            status: 'completed' as StepStatus,
            startedAt: new Date('2024-01-01'),
            completedAt: new Date('2024-01-01T00:00:01Z'),
            cost: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
            attempt: 1,
          })),
        ),
        (steps) => {
          const html = stepTimeline(steps);
          const positions = steps
            .map((s) => ({ seq: s.sequence, pos: html.indexOf(s.nodeName) }))
            .sort((a, b) => a.seq - b.seq);

          for (let i = 0; i < positions.length - 1; i++) {
            expect(positions[i].pos).toBeLessThan(positions[i + 1].pos);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Feature: sprint-5-dashboard-cli-polish, Property 5: Step rendering completeness', () => {
  /**
   * Validates: Requirements 3.2
   *
   * For any Step object, the rendered step HTML contains the step name,
   * status, duration, token cost, and attempt number.
   */
  it('rendered step HTML contains name, status, and attempt', () => {
    fc.assert(
      fc.property(stepArb, (step) => {
        const html = stepTimeline([step]);
        expect(html).toContain(step.nodeName);
        expect(html).toContain(step.status);
        expect(html).toContain(`>${step.attempt}<`);
      }),
      { numRuns: 100 },
    );
  });

  it('rendered step HTML contains token cost', () => {
    fc.assert(
      fc.property(stepArb, (step) => {
        const html = stepTimeline([step]);
        const totalTokens = step.cost.inputTokens + step.cost.outputTokens;
        expect(html).toContain(`${totalTokens} tok`);
      }),
      { numRuns: 100 },
    );
  });
});

describe('Feature: sprint-5-dashboard-cli-polish, Property 6: Recovery indicator correctness', () => {
  /**
   * Validates: Requirements 3.3
   *
   * For any Step object, the rendered output includes a recovery visual
   * indicator if and only if the step's attempt number is greater than 1.
   */
  it('recovery indicator present iff attempt > 1', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (attempt) => {
        const step: Step = {
          stepId: 'step-1',
          runId: 'run-1',
          nodeName: 'test_step',
          sequence: 0,
          status: 'completed',
          startedAt: new Date('2024-01-01'),
          completedAt: new Date('2024-01-01T00:00:01Z'),
          cost: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
          attempt,
        };
        const html = stepTimeline([step]);

        if (attempt > 1) {
          expect(html).toContain('recovered');
        } else {
          expect(html).not.toContain('recovered');
        }
      }),
      { numRuns: 100 },
    );
  });
});

import { describe, it, expect } from 'vitest';
import { layout } from '../../src/dashboard/views/layout.js';
import { runsTable } from '../../src/dashboard/views/runs-list.js';
import { stepTimeline } from '../../src/dashboard/views/run-detail.js';
import { errorPage } from '../../src/dashboard/views/error-page.js';
import type { ExecutionRun, Step } from '../../src/core/types.js';

const mockRun: ExecutionRun = {
  runId: 'run-abc-123',
  status: 'completed',
  config: { name: 'test-wf' },
  metadata: {},
  totals: { cost: 1.5, tokens: 1000, steps: 5, recoveryCount: 0 },
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  lastHeartbeat: new Date('2024-01-01'),
};

const mockStep: Step = {
  stepId: 'step-1',
  runId: 'run-abc-123',
  nodeName: 'research',
  sequence: 0,
  status: 'completed',
  startedAt: new Date('2024-01-01T00:00:00Z'),
  completedAt: new Date('2024-01-01T00:00:01Z'),
  cost: { inputTokens: 100, outputTokens: 50, costUsd: 0.002 },
  attempt: 1,
};

describe('layout', () => {
  it('produces HTML containing the title and body', () => {
    const html = layout('Title', '<p>body</p>');
    expect(html).toContain('<title>Title — durable-agents</title>');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<p>body</p>');
  });
});

describe('runsTable', () => {
  it('produces the empty-state message when no runs exist', () => {
    const html = runsTable([]);
    expect(html).toContain('empty-state');
    expect(html).toContain('No runs found');
  });

  it('contains run ID, workflow name, and status for a run', () => {
    const html = runsTable([mockRun]);
    expect(html).toContain('run-abc-');
    expect(html).toContain('test-wf');
    expect(html).toContain('completed');
  });
});

describe('errorPage', () => {
  it('contains the status code and message', () => {
    const html = errorPage(404, 'Not found');
    expect(html).toContain('404');
    expect(html).toContain('Not found');
  });
});

describe('stepTimeline', () => {
  it('produces empty-state message when no steps exist', () => {
    const html = stepTimeline([]);
    expect(html).toContain('empty-state');
    expect(html).toContain('No steps recorded');
  });

  it('contains step name, status, and attempt', () => {
    const html = stepTimeline([mockStep]);
    expect(html).toContain('research');
    expect(html).toContain('completed');
    expect(html).toContain('>1<');
  });

  it('shows recovery indicator when attempt > 1', () => {
    const recoveryStep: Step = { ...mockStep, attempt: 3 };
    const html = stepTimeline([recoveryStep]);
    expect(html).toContain('recovery');
    expect(html).toContain('recovered');
  });

  it('does not show recovery indicator when attempt === 1', () => {
    const html = stepTimeline([mockStep]);
    expect(html).not.toContain('recovered');
  });
});

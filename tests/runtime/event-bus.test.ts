import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/runtime/event-bus.js';
import type { RunStartedEvent, StepStartedEvent } from '../../src/core/types.js';

describe('EventBus', () => {
  it('on() registers a handler that receives emitted events', () => {
    const bus = new EventBus();
    const received: RunStartedEvent[] = [];

    bus.on('run:started', (event) => received.push(event));

    const event: RunStartedEvent = {
      type: 'run:started',
      timestamp: new Date(),
      runId: 'run-1',
      config: { name: 'test-workflow' },
    };
    bus.emit('run:started', event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it('multiple handlers registered for same event type all receive the event', () => {
    const bus = new EventBus();
    let callCount = 0;

    bus.on('run:started', () => callCount++);
    bus.on('run:started', () => callCount++);
    bus.on('run:started', () => callCount++);

    bus.emit('run:started', {
      type: 'run:started',
      timestamp: new Date(),
      runId: 'run-1',
      config: { name: 'test-workflow' },
    });

    expect(callCount).toBe(3);
  });

  it('handlers are called in registration order', () => {
    const bus = new EventBus();
    const order: number[] = [];

    bus.on('run:started', () => order.push(1));
    bus.on('run:started', () => order.push(2));
    bus.on('run:started', () => order.push(3));

    bus.emit('run:started', {
      type: 'run:started',
      timestamp: new Date(),
      runId: 'run-1',
      config: { name: 'test-workflow' },
    });

    expect(order).toEqual([1, 2, 3]);
  });

  it('off() removes a specific handler so it no longer receives events', () => {
    const bus = new EventBus();
    const received: string[] = [];

    const handler = () => received.push('removed');
    bus.on('run:started', handler);
    bus.on('run:started', () => received.push('kept'));

    bus.off('run:started', handler);

    bus.emit('run:started', {
      type: 'run:started',
      timestamp: new Date(),
      runId: 'run-1',
      config: { name: 'test-workflow' },
    });

    expect(received).toEqual(['kept']);
  });

  it('off() for a handler not registered does not throw', () => {
    const bus = new EventBus();
    const unregistered = () => {};

    expect(() => bus.off('run:started', unregistered)).not.toThrow();
  });

  it('emit() with no registered handlers does not throw', () => {
    const bus = new EventBus();

    expect(() =>
      bus.emit('run:started', {
        type: 'run:started',
        timestamp: new Date(),
        runId: 'run-1',
        config: { name: 'test-workflow' },
      }),
    ).not.toThrow();
  });

  it('handlers for different event types do not interfere', () => {
    const bus = new EventBus();
    const runCalls: string[] = [];
    const stepCalls: string[] = [];

    bus.on('run:started', () => runCalls.push('run'));
    bus.on('step:started', () => stepCalls.push('step'));

    bus.emit('run:started', {
      type: 'run:started',
      timestamp: new Date(),
      runId: 'run-1',
      config: { name: 'test-workflow' },
    });

    expect(runCalls).toEqual(['run']);
    expect(stepCalls).toEqual([]);

    bus.emit('step:started', {
      type: 'step:started',
      timestamp: new Date(),
      runId: 'run-1',
      stepId: 'step-1',
      nodeName: 'node-a',
      sequence: 0,
    } satisfies StepStartedEvent);

    expect(runCalls).toEqual(['run']);
    expect(stepCalls).toEqual(['step']);
  });
});

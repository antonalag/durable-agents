import type { Context } from 'hono';
import type { EventBus } from '../runtime/event-bus.js';
import type { DurableEvent, EventMap } from '../core/types.js';

const ALL_EVENT_TYPES: Array<keyof EventMap> = [
  'run:started',
  'run:completed',
  'run:failed',
  'run:recovered',
  'step:started',
  'step:completed',
  'budget:warning',
  'budget:exceeded',
  'loop:detected',
];

export function formatSseEvent(event: DurableEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createSseHandler(eventBus: EventBus | undefined) {
  return (c: Context) => {
    if (!eventBus) {
      return c.text('SSE requires an EventBus', 400);
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        const handler = (event: DurableEvent) => {
          try {
            controller.enqueue(encoder.encode(formatSseEvent(event)));
          } catch {
            // Stream already closed
          }
        };

        for (const type of ALL_EVENT_TYPES) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          eventBus.on(type, handler as any);
        }

        c.req.raw.signal.addEventListener('abort', () => {
          for (const type of ALL_EVENT_TYPES) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            eventBus.off(type, handler as any);
          }
          try {
            controller.close();
          } catch {
            // Already closed
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  };
}

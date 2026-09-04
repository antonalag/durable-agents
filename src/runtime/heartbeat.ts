import type { JournalStore } from '../stores/interface.js';
import type { EventBus } from './event-bus.js';

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: JournalStore,
    private runId: string,
    private intervalMs: number,
    private eventBus?: EventBus,
  ) {}

  start(): void {
    if (this.timer) return;

    this.beat();
    this.timer = setInterval(() => {
      this.beat();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  private beat(): void {
    this.store.updateHeartbeat(this.runId).catch((err: unknown) => {
      this.eventBus?.emit('heartbeat:failed', {
        type: 'heartbeat:failed',
        timestamp: new Date(),
        runId: this.runId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    });
  }
}

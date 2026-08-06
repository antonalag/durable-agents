import type { JournalStore } from '../stores/interface.js';

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: JournalStore,
    private runId: string,
    private intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;

    void this.store.updateHeartbeat(this.runId);
    this.timer = setInterval(() => {
      void this.store.updateHeartbeat(this.runId);
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
}

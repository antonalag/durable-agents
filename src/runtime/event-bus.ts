import type { DurableEvent, EventMap } from '../core/types.js';

type EventHandler<E extends DurableEvent> = (event: E) => void;

export class EventBus {
  private listeners = new Map<string, Set<EventHandler<DurableEvent>>>();

  on<K extends keyof EventMap>(type: K, handler: EventHandler<EventMap[K]>): void {
    let set = this.listeners.get(type as string);
    if (!set) {
      set = new Set();
      this.listeners.set(type as string, set);
    }
    set.add(handler as EventHandler<DurableEvent>);
  }

  off<K extends keyof EventMap>(type: K, handler: EventHandler<EventMap[K]>): void {
    const set = this.listeners.get(type as string);
    if (set) {
      set.delete(handler as EventHandler<DurableEvent>);
    }
  }

  emit<K extends keyof EventMap>(type: K, event: EventMap[K]): void {
    const set = this.listeners.get(type as string);
    if (set) {
      for (const handler of set) {
        handler(event);
      }
    }
  }
}

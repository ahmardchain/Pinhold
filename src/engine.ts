// Glue between events, the pure state machine, the executor and notifications.
// One entry point: `apply(bookingId, event)`. Serialized per booking.

import { decide } from "./core/machine.js";
import type { Booking, BookingEvent } from "./core/types.js";
import type { Store } from "./db.js";
import type { Executor } from "./executor.js";

export interface Notifier {
  notify(booking: Booking, to: "owner" | "sponsor", text: string): Promise<void>;
}

export class Engine {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly executor: Executor,
    private readonly notifier: Notifier,
    private readonly now: () => number,
    private readonly log: (line: string) => void,
  ) {}

  apply(bookingId: string, event: BookingEvent): Promise<Booking | null> {
    const prev = this.locks.get(bookingId) ?? Promise.resolve();
    const next = prev.then(() => this.applyNow(bookingId, event)).catch((e) => {
      this.log(`Booking ${bookingId}: ${event.type} failed: ${(e as Error).message}`);
      return this.store.getBooking(bookingId);
    });
    this.locks.set(bookingId, next);
    return next;
  }

  private async applyNow(bookingId: string, event: BookingEvent): Promise<Booking | null> {
    let b = this.store.getBooking(bookingId);
    if (!b) return null;
    const queue: BookingEvent[] = [event];
    while (queue.length) {
      const ev = queue.shift()!;
      const now = this.now();
      const d = decide(b, ev, now);
      b = d.booking;
      this.store.saveBooking(b);
      if (d.log) this.store.log(b.id, now, d.log);
      for (const a of d.actions) {
        if (a.type === "NOTIFY") {
          await this.notifier.notify(b, a.to, a.text).catch((e) => this.log(`notify failed: ${(e as Error).message}`));
        } else if (a.type === "RELEASE") {
          queue.push(await this.executor.release(b));
        } else if (a.type === "REFUND") {
          queue.push(await this.executor.refund(b));
        }
      }
    }
    return b;
  }
}

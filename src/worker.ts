// The clock. Every minute: post checks for live bookings (spaced by CHECK_INTERVAL), then a
// TICK for every open booking so deadlines and hold windows are evaluated.
// A final existence check always runs right before a hold window is allowed to complete.

import type { Booking } from "./core/types.js";
import type { Store } from "./db.js";
import type { Engine } from "./engine.js";
import type { PostProbe } from "./telegram/probe.js";

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastCheck = new Map<string, number>();
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly engine: Engine,
    private readonly probe: PostProbe,
    private readonly checkIntervalMs: number,
    private readonly now: () => number,
    private readonly log: (line: string) => void,
  ) {}

  start(everyMs = 60_000): void {
    this.timer = setInterval(() => void this.tick(), everyMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private dueForCheck(b: Booking, now: number): boolean {
    const holdDone = b.holdEndsAt !== null && now >= b.holdEndsAt;
    const last = this.lastCheck.get(b.id) ?? 0;
    return holdDone || b.missedChecks > 0 || now - last >= this.checkIntervalMs;
  }

  async checkPost(b: Booking): Promise<void> {
    const r = await this.probe.postExists(b);
    this.lastCheck.set(b.id, this.now());
    if (r === "ok") await this.engine.apply(b.id, { type: "CHECK_OK" });
    else if (r === "missing") await this.engine.apply(b.id, { type: "CHECK_MISSING" });
    else this.store.log(b.id, this.now(), "Existence check inconclusive (Telegram unreachable or copy restricted); will retry");
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      for (const b of this.store.listBookings(["LIVE"])) {
        if (this.dueForCheck(b, now)) await this.checkPost(b);
      }
      for (const b of this.store.listBookings(["QUOTED", "PAID", "LIVE", "RELEASING", "REFUNDING"])) {
        const fresh = this.store.getBooking(b.id)!;
        // Do not let a hold complete on a post that just failed its check.
        if (fresh.state === "LIVE" && fresh.missedChecks > 0) continue;
        await this.engine.apply(b.id, { type: "TICK" });
      }
    } catch (e) {
      this.log(`worker tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

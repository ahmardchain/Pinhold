import { describe, expect, it } from "vitest";
import { decide } from "../src/core/machine.js";
import type { Booking, BookingEvent } from "../src/core/types.js";
import { booking, HOUR, T0, USDT } from "./fixtures.js";

const PAYER = "0x3333333333333333333333333333333333333333" as const;
const TX = (n: number) => (`0x${n.toString(16).padStart(64, "0")}`) as `0x${string}`;

function run(start: Booking, steps: Array<[BookingEvent, number]>) {
  let b = start;
  const actions: string[] = [];
  const logs: string[] = [];
  for (const [event, at] of steps) {
    const d = decide(b, event, at);
    b = d.booking;
    actions.push(...d.actions.map((a) => (a.type === "REFUND" ? `REFUND:${a.reason}` : a.type)));
    if (d.log) logs.push(d.log);
  }
  return { b, actions, logs };
}

const paid: Array<[BookingEvent, number]> = [
  [{ type: "PAYMENT_SETTLED", payer: PAYER, tx: TX(1), amount: USDT(3.4) }, T0 + 60_000],
];
const live: Array<[BookingEvent, number]> = [
  ...paid,
  [{ type: "POST_SEEN", messageId: 42, text: "Try Acme Bank today.\nhttps://acme.example" }, T0 + HOUR],
];

describe("booking state machine", () => {
  it("post stays up for the hold window: releases", () => {
    const { b, actions } = run(booking(), [
      ...live,
      [{ type: "CHECK_OK" }, T0 + 2 * HOUR],
      [{ type: "TICK" }, T0 + 24 * HOUR], // 23 h after posting: not yet
      [{ type: "TICK" }, T0 + 25 * HOUR], // 24 h after posting
    ]);
    expect(b.state).toBe("RELEASING");
    expect(actions).toContain("RELEASE");
    const done = decide(b, {
      type: "RELEASE_DONE", swapTx: TX(2), payoutTx: TX(3), surplusTx: null,
      cngnPaid: 5_000_000_000n, usdtSpent: USDT(3.3),
    }, T0 + 25 * HOUR + 60_000);
    expect(done.booking.state).toBe("RELEASED");
    expect(done.booking.payoutTx).toBe(TX(3));
  });

  it("post deleted during the hold window: refunds after consecutive missed checks", () => {
    const { b, actions } = run(booking(), [
      ...live,
      [{ type: "CHECK_MISSING" }, T0 + 3 * HOUR],
    ]);
    expect(b.state).toBe("LIVE"); // one miss is not enough (Telegram hiccup)
    const second = decide(b, { type: "CHECK_MISSING" }, T0 + 3 * HOUR + 600_000);
    expect(second.booking.state).toBe("REFUNDING");
    expect(second.booking.refundReason).toBe("deleted");
    expect([...actions, ...second.actions.map((a) => a.type)]).toContain("REFUND");
  });

  it("a missed check followed by a found check resets the counter", () => {
    const { b } = run(booking(), [
      ...live,
      [{ type: "CHECK_MISSING" }, T0 + 3 * HOUR],
      [{ type: "CHECK_OK" }, T0 + 3 * HOUR + 600_000],
      [{ type: "CHECK_MISSING" }, T0 + 4 * HOUR],
    ]);
    expect(b.state).toBe("LIVE");
    expect(b.missedChecks).toBe(1);
  });

  it("post edited away from the booked text: refunds", () => {
    const { b, actions } = run(booking(), [
      ...live,
      [{ type: "POST_EDITED", messageId: 42, text: "Try Rival Bank instead" }, T0 + 5 * HOUR],
    ]);
    expect(b.state).toBe("REFUNDING");
    expect(b.refundReason).toBe("edited");
    expect(actions).toContain("REFUND:edited");
  });

  it("edit that keeps the same text (whitespace only) does not refund", () => {
    const { b } = run(booking(), [
      ...live,
      [{ type: "POST_EDITED", messageId: 42, text: "Try  Acme Bank today. \n https://acme.example​" }, T0 + 5 * HOUR],
    ]);
    expect(b.state).toBe("LIVE");
  });

  it("post never goes up before the deadline: refunds", () => {
    const { b, actions } = run(booking(), [
      ...paid,
      [{ type: "TICK" }, T0 + 11 * HOUR],
      [{ type: "TICK" }, T0 + 12 * HOUR],
    ]);
    expect(b.state).toBe("REFUNDING");
    expect(b.refundReason).toBe("never_posted");
    expect(actions).toContain("REFUND:never_posted");
  });

  it("a post with different text does not start the hold", () => {
    const { b } = run(booking(), [
      ...paid,
      [{ type: "POST_SEEN", messageId: 43, text: "Something else entirely" }, T0 + HOUR],
    ]);
    expect(b.state).toBe("PAID");
    expect(b.messageId).toBeNull();
  });

  it("unpaid quote expires and moves nothing", () => {
    const { b, actions } = run(booking(), [[{ type: "TICK" }, T0 + 31 * 60_000]]);
    expect(b.state).toBe("EXPIRED");
    expect(actions).toEqual([]);
  });

  it("over the daily cap: payout is deferred, not sent, then retried next day", () => {
    const { b } = run(booking(), [...live, [{ type: "TICK" }, T0 + 25 * HOUR]]);
    const nextDay = Date.UTC(2026, 10, 30);
    const deferred = decide(b, { type: "DEFERRED", until: nextDay }, T0 + 25 * HOUR);
    expect(deferred.booking.state).toBe("RELEASING");
    expect(deferred.actions).toEqual([]);
    expect(decide(deferred.booking, { type: "TICK" }, nextDay - 1).actions).toEqual([]);
    expect(decide(deferred.booking, { type: "TICK" }, nextDay).actions.map((a) => a.type)).toEqual(["RELEASE"]);
  });

  it("owner unverified at payout time: refunds the sponsor instead", () => {
    const { b } = run(booking(), [...live, [{ type: "TICK" }, T0 + 25 * HOUR]]);
    const d = decide(b, { type: "OWNER_REJECTED", reason: "owner_unverified" }, T0 + 25 * HOUR);
    expect(d.booking.state).toBe("REFUNDING");
    expect(d.booking.refundReason).toBe("owner_unverified");
  });

  it("no FX quote: retries, then refunds after the retry window", () => {
    const { b } = run(booking(), [...live, [{ type: "TICK" }, T0 + 25 * HOUR]]);
    expect(decide(b, { type: "FX_UNAVAILABLE" }, T0 + 26 * HOUR).booking.state).toBe("RELEASING");
    expect(decide(b, { type: "FX_UNAVAILABLE" }, T0 + 32 * HOUR).booking.state).toBe("REFUNDING");
  });

  it("refund completes", () => {
    const { b } = run(booking(), [...paid, [{ type: "TICK" }, T0 + 12 * HOUR]]);
    const d = decide(b, { type: "REFUND_DONE", refundTx: TX(9) }, T0 + 12 * HOUR + 1);
    expect(d.booking.state).toBe("REFUNDED");
    expect(d.booking.refundTx).toBe(TX(9));
  });

  it("terminal states ignore every event", () => {
    for (const state of ["RELEASED", "REFUNDED", "EXPIRED"] as const) {
      const d = decide(booking({ state }), { type: "CHECK_MISSING" }, T0);
      expect(d.booking.state).toBe(state);
      expect(d.actions).toEqual([]);
    }
  });

  it("underpayment does not fund the escrow", () => {
    const d = decide(booking(), { type: "PAYMENT_SETTLED", payer: PAYER, tx: TX(1), amount: USDT(1) }, T0);
    expect(d.booking.state).toBe("QUOTED");
  });
});

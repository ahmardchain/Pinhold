// The booking state machine. Pure: no I/O, no clock, no randomness.
// decide(booking, event, now) returns the next booking, the actions to run, and a
// one-line log for the receipt timeline. Only this function decides release or refund.

import { textMatches } from "./match.js";
import {
  type Action,
  type Booking,
  type BookingEvent,
  type Decision,
  DEFAULT_POLICY,
  type Policy,
  type RefundReason,
  TERMINAL_STATES,
} from "./types.js";

const HOUR = 3_600_000;

function same(booking: Booking, log: string | null = null): Decision {
  return { booking, actions: [], log };
}

function move(
  booking: Booking,
  patch: Partial<Booking>,
  now: number,
  actions: Action[],
  log: string,
): Decision {
  return { booking: { ...booking, ...patch, updatedAt: now }, actions, log };
}

function refund(booking: Booking, reason: RefundReason, now: number, log: string): Decision {
  return move(booking, { state: "REFUNDING", refundReason: reason, deferredUntil: null }, now, [
    { type: "REFUND", reason },
    { type: "NOTIFY", to: "sponsor", text: `Booking ${booking.id}: refunding your USD₮ (${reason}).` },
    { type: "NOTIFY", to: "owner", text: `Booking ${booking.id} will not be paid: ${reason}.` },
  ], log);
}

export function decide(
  booking: Booking,
  event: BookingEvent,
  now: number,
  policy: Policy = DEFAULT_POLICY,
): Decision {
  if (TERMINAL_STATES.includes(booking.state)) return same(booking);

  switch (booking.state) {
    case "QUOTED": {
      if (event.type === "PAYMENT_SETTLED") {
        if (event.amount < booking.priceUsdt) {
          // The x402 route prices the exact amount, so this should never happen. If it
          // does, keep the booking unpaid; the underpayment is visible on the receipt.
          return same(booking, `Payment ${event.tx} below price, booking stays unpaid`);
        }
        return move(booking, { state: "PAID", payer: event.payer, paymentTx: event.tx }, now, [
          { type: "NOTIFY", to: "owner", text: `New paid booking ${booking.id}. Publish the exact text in your channel.` },
        ], `Escrow funded by ${event.payer} (x402)`);
      }
      if (event.type === "TICK" && now >= booking.quoteExpiresAt) {
        return move(booking, { state: "EXPIRED" }, now, [], "Quote expired unpaid; nothing moved");
      }
      return same(booking);
    }

    case "PAID": {
      if (event.type === "POST_SEEN") {
        if (!textMatches(booking.postText, event.text)) {
          return same(booking, `Post ${event.messageId} seen but text differs from booking; ignored`);
        }
        return move(booking, {
          state: "LIVE",
          messageId: event.messageId,
          postSeenAt: now,
          holdEndsAt: now + booking.holdHours * HOUR,
          missedChecks: 0,
        }, now, [
          { type: "NOTIFY", to: "sponsor", text: `Booking ${booking.id} is live. Hold window: ${booking.holdHours} h.` },
        ], `Post ${event.messageId} live, text matches; hold ${booking.holdHours} h started`);
      }
      if (event.type === "TICK" && now >= booking.postDeadline) {
        return refund(booking, "never_posted", now, "Post deadline passed without the booked post");
      }
      return same(booking);
    }

    case "LIVE": {
      if (event.type === "POST_EDITED" && event.messageId === booking.messageId) {
        if (textMatches(booking.postText, event.text)) {
          return same(booking, "Post edited, text still matches");
        }
        return refund(booking, "edited", now, "Post edited away from the booked text");
      }
      if (event.type === "CHECK_OK") {
        return booking.missedChecks === 0
          ? same(booking)
          : move(booking, { missedChecks: 0 }, now, [], "Post found again after a missed check");
      }
      if (event.type === "CHECK_MISSING") {
        const missed = booking.missedChecks + 1;
        if (missed >= policy.missedChecksToDelete) {
          return refund({ ...booking, missedChecks: missed }, "deleted", now, `Post missing on ${missed} checks in a row: deleted`);
        }
        return move(booking, { missedChecks: missed }, now, [], `Post missing on check ${missed}; re-checking`);
      }
      if (event.type === "TICK" && booking.holdEndsAt !== null && now >= booking.holdEndsAt) {
        return move(booking, { state: "RELEASING" }, now, [{ type: "RELEASE" }], "Hold window complete; releasing");
      }
      return same(booking);
    }

    case "RELEASING": {
      if (event.type === "RELEASE_DONE") {
        return move(booking, {
          state: "RELEASED",
          swapTx: event.swapTx,
          payoutTx: event.payoutTx,
          surplusTx: event.surplusTx,
          cngnPaid: event.cngnPaid,
          usdtSpent: event.usdtSpent,
          deferredUntil: null,
        }, now, [
          { type: "NOTIFY", to: "owner", text: `Booking ${booking.id} paid out in cNGN.` },
          { type: "NOTIFY", to: "sponsor", text: `Booking ${booking.id} completed; owner paid.` },
        ], "Released: swapped to cNGN on Textile and paid to the verified owner's wallet");
      }
      if (event.type === "OWNER_REJECTED") {
        return refund(booking, event.reason, now, `Payout refused: ${event.reason}`);
      }
      if (event.type === "DEFERRED") {
        return move(booking, { deferredUntil: event.until }, now, [], "Daily outflow cap reached; payout deferred");
      }
      if (event.type === "FX_UNAVAILABLE") {
        const since = booking.holdEndsAt ?? now;
        if (now - since >= policy.fxRetryWindowMs) {
          return refund(booking, "no_fx_quote", now, "No Textile quote for too long; refunding");
        }
        return same(booking, "No Textile quote yet; will retry");
      }
      if (event.type === "TICK" && booking.deferredUntil !== null && now >= booking.deferredUntil) {
        return move(booking, { deferredUntil: null }, now, [{ type: "RELEASE" }], "Retrying deferred payout");
      }
      return same(booking);
    }

    case "REFUNDING": {
      if (event.type === "REFUND_DONE") {
        return move(booking, { state: "REFUNDED", refundTx: event.refundTx, deferredUntil: null }, now, [],
          "Refunded to the payer");
      }
      if (event.type === "DEFERRED") {
        return move(booking, { deferredUntil: event.until }, now, [], "Daily outflow cap reached; refund deferred");
      }
      if (event.type === "TICK" && booking.deferredUntil !== null && now >= booking.deferredUntil) {
        return move(booking, { deferredUntil: null }, now,
          [{ type: "REFUND", reason: booking.refundReason ?? "never_posted" }], "Retrying deferred refund");
      }
      return same(booking);
    }

    default:
      return same(booking);
  }
}

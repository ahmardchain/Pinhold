// Domain types shared by the state machine, the API, the worker and the verify script.
// Amounts are bigint in base units: USD₮ and cNGN both use 6 decimals on Celo.

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export type BookingState =
  | "QUOTED" // created by a verified sponsor agent, waiting for the x402 payment
  | "PAID" // escrow funded, waiting for the owner to publish the post
  | "LIVE" // post seen and matches the booked text, hold window running
  | "RELEASING" // hold window done, swap + payout in progress
  | "RELEASED" // owner paid in cNGN
  | "REFUNDING" // refund to the payer in progress
  | "REFUNDED" // payer got the USD₮ back
  | "EXPIRED"; // quote was never paid, nothing moved

export const TERMINAL_STATES: readonly BookingState[] = ["RELEASED", "REFUNDED", "EXPIRED"];

export type RefundReason =
  | "never_posted" // post did not appear before the post deadline
  | "deleted" // post removed during the hold window
  | "edited" // post edited away from the booked text during the hold window
  | "owner_unverified" // owner's Self proof missing, stale or not bound to the payout wallet
  | "owner_not_admin" // the owner is no longer an admin of the channel
  | "no_fx_quote"; // Textile could not quote the payout for too long

export interface Booking {
  id: string;
  state: BookingState;
  channelId: string; // Telegram chat id of the channel
  channelUsername: string | null; // public @username, null for private channels
  ownerId: string; // Owner.id
  // What was booked
  postText: string;
  holdHours: number;
  priceNgn: bigint; // cNGN base units the owner receives
  priceUsdt: bigint; // USD₮ base units the sponsor pays (FX estimate + buffer)
  // Who booked it (Self Agent ID of the sponsor's agent)
  sponsorAgentId: string;
  sponsorAgentAddress: Address;
  sponsorNullifier: string;
  // Escrow
  payer: Address | null; // x402 payer; refunds can only go here
  paymentTx: Hex | null;
  // Post
  messageId: number | null;
  postSeenAt: number | null; // unix ms
  missedChecks: number;
  // Deadlines (unix ms)
  createdAt: number;
  quoteExpiresAt: number;
  postDeadline: number;
  holdEndsAt: number | null;
  // Outcome
  refundReason: RefundReason | null;
  swapTx: Hex | null;
  payoutTx: Hex | null;
  surplusTx: Hex | null;
  refundTx: Hex | null;
  cngnPaid: bigint | null;
  usdtSpent: bigint | null; // takerPays of the swap
  deferredUntil: number | null; // set when the daily cap blocks an outflow
  updatedAt: number;
}

export interface Owner {
  id: string;
  telegramUserId: number;
  channelId: string;
  channelUsername: string | null;
  channelTitle: string;
  payoutWallet: Address;
  selfAgentId: string | null; // Self Agent ID registered with humanAddress = payoutWallet
  priceNgn: bigint;
  holdHours: number;
  createdAt: number;
}

export type BookingEvent =
  | { type: "PAYMENT_SETTLED"; payer: Address; tx: Hex; amount: bigint }
  | { type: "POST_SEEN"; messageId: number; text: string }
  | { type: "POST_EDITED"; messageId: number; text: string }
  | { type: "CHECK_OK" }
  | { type: "CHECK_MISSING" }
  | { type: "TICK" }
  | { type: "OWNER_REJECTED"; reason: "owner_unverified" | "owner_not_admin" }
  | { type: "RELEASE_DONE"; swapTx: Hex; payoutTx: Hex; surplusTx: Hex | null; cngnPaid: bigint; usdtSpent: bigint }
  | { type: "REFUND_DONE"; refundTx: Hex }
  | { type: "DEFERRED"; until: number }
  | { type: "FX_UNAVAILABLE" };

export type Action =
  | { type: "RELEASE" } // owner checks, daily cap, Textile swap, cNGN payout, surplus refund
  | { type: "REFUND"; reason: RefundReason } // USD₮ back to booking.payer
  | { type: "NOTIFY"; to: "owner" | "sponsor"; text: string };

export interface Decision {
  booking: Booking;
  actions: Action[];
  log: string | null; // one line for the public receipt timeline
}

export interface Policy {
  quoteTtlMs: number; // how long a quote waits for payment
  missedChecksToDelete: number; // consecutive failed existence checks before "deleted"
  fxRetryWindowMs: number; // how long to keep retrying Textile before refunding
}

export const DEFAULT_POLICY: Policy = {
  quoteTtlMs: 30 * 60_000,
  missedChecksToDelete: 2,
  fxRetryWindowMs: 6 * 3_600_000,
};

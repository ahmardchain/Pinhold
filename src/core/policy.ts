// Pure rules about who gets served, who can be paid, and how much may leave per day.
// The API and the executor call these; the tests pin them.

import type { Address, Booking, Owner } from "./types.js";

// ---------- Sponsor admission (Self Agent ID decides who gets served) ----------

export interface SponsorIdentity {
  valid: boolean; // SelfAgentVerifier result: signature + isVerifiedAgent + isProofFresh
  error?: string;
  agentId: bigint;
  agentAddress: string;
  nullifier: bigint; // read from the registry: getHumanNullifier(agentId)
}

export type AdmissionResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 404 | 409 | 422; code: string; message: string };

export interface AdmissionInput {
  sponsor: SponsorIdentity;
  openEscrowsForHuman: number; // non-terminal bookings for this nullifier
  maxOpenEscrowsPerHuman: number;
  owner: Owner | null;
  ownerVerified: boolean; // registry read for the owner's Self agent
  postText: string;
  priceUsdt: bigint;
  maxBookingUsdt: bigint;
  minBookingUsdt: bigint;
}

export function admitBooking(i: AdmissionInput): AdmissionResult {
  if (!i.sponsor.valid || i.sponsor.agentId === 0n) {
    return {
      ok: false,
      status: 401,
      code: "agent_not_verified",
      message: `Pinhold only serves agents with a fresh Self Agent ID proof. ${i.sponsor.error ?? ""}`.trim(),
    };
  }
  if (i.sponsor.nullifier === 0n) {
    return { ok: false, status: 401, code: "no_human_nullifier", message: "Agent has no human nullifier on the registry." };
  }
  if (i.openEscrowsForHuman >= i.maxOpenEscrowsPerHuman) {
    return {
      ok: false,
      status: 409,
      code: "open_escrow_limit",
      message: `The human behind this agent already has ${i.openEscrowsForHuman} open booking(s); the limit is ${i.maxOpenEscrowsPerHuman} per person, across all of their agents.`,
    };
  }
  if (!i.owner) {
    return { ok: false, status: 404, code: "unknown_channel", message: "That channel is not listed on Pinhold." };
  }
  if (!i.ownerVerified) {
    return { ok: false, status: 403, code: "owner_not_verified", message: "The channel owner has not verified with Self, so Pinhold will not take bookings for it." };
  }
  const text = i.postText.trim();
  if (text.length < 1 || text.length > 4096) {
    return { ok: false, status: 422, code: "bad_text", message: "Post text must be 1 to 4096 characters (Telegram's limit)." };
  }
  if (i.priceUsdt < i.minBookingUsdt) {
    return { ok: false, status: 422, code: "below_minimum", message: "Booking is below the minimum Textile can convert." };
  }
  if (i.priceUsdt > i.maxBookingUsdt) {
    return { ok: false, status: 422, code: "above_maximum", message: "Booking is above Pinhold's per-booking maximum." };
  }
  return { ok: true };
}

// ---------- Payout and refund targets ----------

export interface OwnerProof {
  agentId: bigint;
  nftOwner: Address; // registry.ownerOf(agentId)
  hasHumanProof: boolean; // registry.isVerifiedAgent / hasHumanProof
  proofFresh: boolean; // registry.isProofFresh(agentId)
}

export type TargetCheck = { ok: true; to: Address } | { ok: false; reason: "owner_unverified" | "owner_not_admin" };

/** cNGN can only go to the owner's payout wallet, and only while its Self proof binds that wallet. */
export function payoutTarget(owner: Owner, proof: OwnerProof | null, isChannelAdmin: boolean): TargetCheck {
  if (!isChannelAdmin) return { ok: false, reason: "owner_not_admin" };
  if (!proof || owner.selfAgentId === null) return { ok: false, reason: "owner_unverified" };
  if (proof.agentId.toString() !== owner.selfAgentId) return { ok: false, reason: "owner_unverified" };
  if (!proof.hasHumanProof || !proof.proofFresh) return { ok: false, reason: "owner_unverified" };
  if (proof.nftOwner.toLowerCase() !== owner.payoutWallet.toLowerCase()) return { ok: false, reason: "owner_unverified" };
  return { ok: true, to: owner.payoutWallet };
}

/** USD₮ refunds can only go back to the wallet that paid the escrow. */
export function refundTarget(booking: Booking): Address {
  if (!booking.payer) throw new Error(`Booking ${booking.id} has no payer; nothing to refund`);
  return booking.payer;
}

// ---------- Daily outflow cap (replaces a wallet-level session cap) ----------

export function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export type CapCheck = { ok: true } | { ok: false; retryAt: number };

/** Every USD₮ outflow (swap input, refunds, surplus) counts against one UTC-day cap. */
export function checkDailyCap(spentToday: bigint, amount: bigint, cap: bigint, now: number): CapCheck {
  if (spentToday + amount <= cap) return { ok: true };
  return { ok: false, retryAt: utcDayStart(now) + 86_400_000 };
}

// ---------- Pricing ----------

/** USD₮ the sponsor pays: Textile's exact-output estimate plus a rate buffer, rounded up to a cent. */
export function sponsorPrice(fxEstimateUsdt: bigint, bufferBps: number): bigint {
  const withBuffer = (fxEstimateUsdt * BigInt(10_000 + bufferBps) + 9_999n) / 10_000n;
  const cent = 10_000n; // 6 decimals
  return ((withBuffer + cent - 1n) / cent) * cent;
}

/** Surplus left after the swap, returned to the payer only when it is worth a transfer. */
export function surplus(paid: bigint, swapSpent: bigint, minReturn: bigint): bigint {
  const left = paid - swapSpent;
  return left >= minReturn ? left : 0n;
}

import { describe, expect, it } from "vitest";
import {
  admitBooking,
  checkDailyCap,
  payoutTarget,
  refundTarget,
  sponsorPrice,
  surplus,
  type AdmissionInput,
} from "../src/core/policy.js";
import { booking, owner, T0, USDT } from "./fixtures.js";

const verified = { valid: true, agentId: 41n, agentAddress: "0x1111111111111111111111111111111111111111", nullifier: 999n };

function input(patch: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    sponsor: verified,
    openEscrowsForHuman: 0,
    maxOpenEscrowsPerHuman: 1,
    owner: owner(),
    ownerVerified: true,
    postText: "Try Acme Bank today.",
    priceUsdt: USDT(3.4),
    maxBookingUsdt: USDT(25),
    minBookingUsdt: USDT(2),
    ...patch,
  };
}

describe("sponsor admission", () => {
  it("serves a verified agent", () => {
    expect(admitBooking(input())).toEqual({ ok: true });
  });

  it("turns away an unverified agent with 401", () => {
    const r = admitBooking(input({ sponsor: { ...verified, valid: false, agentId: 0n, error: "Agent not verified on-chain" } }));
    expect(r).toMatchObject({ ok: false, status: 401, code: "agent_not_verified" });
  });

  it("turns away an agent whose proof expired", () => {
    const r = admitBooking(input({ sponsor: { ...verified, valid: false, error: "Agent's human proof has expired" } }));
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("two agents of the same human share one open-escrow limit", () => {
    // Second agent, same nullifier, while the first agent's booking is still open.
    const second = { ...verified, agentId: 42n, agentAddress: "0x4444444444444444444444444444444444444444" };
    const r = admitBooking(input({ sponsor: second, openEscrowsForHuman: 1 }));
    expect(r).toMatchObject({ ok: false, status: 409, code: "open_escrow_limit" });
  });

  it("refuses channels whose owner has not verified with Self", () => {
    expect(admitBooking(input({ ownerVerified: false }))).toMatchObject({ ok: false, status: 403 });
    expect(admitBooking(input({ owner: null }))).toMatchObject({ ok: false, status: 404 });
  });

  it("enforces booking size bounds", () => {
    expect(admitBooking(input({ priceUsdt: USDT(1) }))).toMatchObject({ ok: false, code: "below_minimum" });
    expect(admitBooking(input({ priceUsdt: USDT(30) }))).toMatchObject({ ok: false, code: "above_maximum" });
  });
});

describe("payout and refund targets", () => {
  const proof = { agentId: 73n, nftOwner: owner().payoutWallet, hasHumanProof: true, proofFresh: true };

  it("pays only the payout wallet bound to the owner's fresh Self proof", () => {
    expect(payoutTarget(owner(), proof, true)).toEqual({ ok: true, to: owner().payoutWallet });
  });

  it("refuses a payout wallet that is not the Self agent's NFT owner (fake admin)", () => {
    const r = payoutTarget(owner({ payoutWallet: "0x5555555555555555555555555555555555555555" }), proof, true);
    expect(r).toEqual({ ok: false, reason: "owner_unverified" });
  });

  it("refuses a stale proof, a missing proof and a mismatched agent id", () => {
    expect(payoutTarget(owner(), { ...proof, proofFresh: false }, true).ok).toBe(false);
    expect(payoutTarget(owner(), null, true).ok).toBe(false);
    expect(payoutTarget(owner(), { ...proof, agentId: 74n }, true).ok).toBe(false);
  });

  it("refuses when the owner is no longer a channel admin", () => {
    expect(payoutTarget(owner(), proof, false)).toEqual({ ok: false, reason: "owner_not_admin" });
  });

  it("refunds only to the payer", () => {
    const payer = "0x3333333333333333333333333333333333333333" as const;
    expect(refundTarget(booking({ payer }))).toBe(payer);
    expect(() => refundTarget(booking({ payer: null }))).toThrow();
  });
});

describe("daily cap and pricing", () => {
  it("allows outflows up to the cap and defers the rest to the next UTC day", () => {
    expect(checkDailyCap(USDT(20), USDT(5), USDT(25), T0)).toEqual({ ok: true });
    const r = checkDailyCap(USDT(20), USDT(5.01), USDT(25), T0);
    expect(r).toEqual({ ok: false, retryAt: Date.UTC(2026, 10, 29) });
  });

  it("adds the rate buffer and rounds up to a cent", () => {
    expect(sponsorPrice(USDT(3.333333), 200)).toBe(USDT(3.4)); // 3.39999966 rounds up to 3.40
    expect(sponsorPrice(USDT(3.35), 200)).toBe(USDT(3.42)); // 3.417 rounds up to 3.42
    expect(sponsorPrice(USDT(2), 0)).toBe(USDT(2));
  });

  it("returns surplus only when it is worth a transfer", () => {
    expect(surplus(USDT(3.41), USDT(3.34), USDT(0.1))).toBe(0n);
    expect(surplus(USDT(3.41), USDT(3.2), USDT(0.1))).toBe(USDT(0.21));
  });
});

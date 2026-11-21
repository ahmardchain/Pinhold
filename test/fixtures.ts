import type { Booking, Owner } from "../src/core/types.js";

export const T0 = Date.UTC(2026, 10, 28, 9, 0, 0);
export const HOUR = 3_600_000;
export const USDT = (n: number) => BigInt(Math.round(n * 1e6));

export function booking(patch: Partial<Booking> = {}): Booking {
  return {
    id: "bk_test",
    state: "QUOTED",
    channelId: "-1001234567890",
    channelUsername: "examplechannel",
    ownerId: "own_1",
    postText: "Try Acme Bank today.\nhttps://acme.example",
    holdHours: 24,
    priceNgn: 5_000_000_000n, // ₦5,000
    priceUsdt: USDT(3.4),
    sponsorAgentId: "41",
    sponsorAgentAddress: "0x1111111111111111111111111111111111111111",
    sponsorNullifier: "999",
    payer: null,
    paymentTx: null,
    messageId: null,
    postSeenAt: null,
    missedChecks: 0,
    createdAt: T0,
    quoteExpiresAt: T0 + 30 * 60_000,
    postDeadline: T0 + 12 * HOUR,
    holdEndsAt: null,
    refundReason: null,
    swapTx: null,
    payoutTx: null,
    surplusTx: null,
    refundTx: null,
    cngnPaid: null,
    usdtSpent: null,
    deferredUntil: null,
    updatedAt: T0,
    ...patch,
  };
}

export function owner(patch: Partial<Owner> = {}): Owner {
  return {
    id: "own_1",
    telegramUserId: 777,
    channelId: "-1001234567890",
    channelUsername: "examplechannel",
    channelTitle: "Example Channel",
    payoutWallet: "0x2222222222222222222222222222222222222222",
    selfAgentId: "73",
    priceNgn: 5_000_000_000n,
    holdHours: 24,
    createdAt: T0,
    ...patch,
  };
}

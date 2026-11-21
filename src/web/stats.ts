// Headline numbers. Computed from the stored tx hashes; `npm run verify` recomputes the
// same numbers from the chain alone and must agree.

import type { Store } from "../db.js";

export interface Stats {
  bookings: number;
  released: number;
  refunded: number;
  open: number;
  usdtIn: bigint;
  cngnOut: bigint;
  usdtRefunded: bigint;
  distinctPayers: number;
  distinctSponsorHumans: number;
  channels: number;
  dryRunTxs: number;
}

export function computeStats(store: Store): Stats {
  const all = store.listBookings();
  const paid = all.filter((b) => b.paymentTx);
  const txs = store.txs();
  const sum = (kind: string) => txs.filter((t) => t.kind === kind && !t.dryRun).reduce((s, t) => s + t.amount, 0n);
  return {
    bookings: paid.length,
    released: all.filter((b) => b.state === "RELEASED").length,
    refunded: all.filter((b) => b.state === "REFUNDED").length,
    open: all.filter((b) => ["PAID", "LIVE", "RELEASING", "REFUNDING"].includes(b.state)).length,
    usdtIn: sum("payment"),
    cngnOut: sum("payout"),
    usdtRefunded: sum("refund") + sum("surplus"),
    distinctPayers: new Set(paid.map((b) => b.payer?.toLowerCase())).size,
    distinctSponsorHumans: new Set(paid.map((b) => b.sponsorNullifier)).size,
    channels: new Set(paid.map((b) => b.channelId)).size,
    dryRunTxs: txs.filter((t) => t.dryRun).length,
  };
}

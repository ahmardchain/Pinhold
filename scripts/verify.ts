// npm run verify: rebuild every Pinhold booking from the chain and check it.
//
// For each booking listed by the public API, every transaction hash is fetched from the
// chain and its ERC-20 Transfer logs are decoded. The script checks, with no trust in
// Pinhold's database beyond the list of hashes:
//   payment  stable moved payer -> agent wallet, for the quoted amount (x402: untagged by design)
//   swap     sent to the Textile reactor, agent wallet received >= the booked cNGN, tagged
//   payout   cNGN moved agent wallet -> owner payout wallet, exact amount, tagged, and the
//            owner's Self agent NFT is owned by that payout wallet on the registry
//   refund   stable moved agent wallet -> the original payer only, tagged
//   surplus  same as refund
// Optional --scan <fromBlock>: list every stable transfer INTO the agent wallet on the escrow
// chain and flag any that no booking accounts for.
//
//   PINHOLD_URL=https://… npm run verify [-- --scan 51234567] [-- --json proof.json]

import { writeFileSync } from "node:fs";
import { fromDataSuffix } from "@celo/attribution-tags";
import { createPublicClient, decodeEventLog, erc20Abi, type Hex, http, parseAbi, parseAbiItem, type PublicClient } from "viem";
import { NETWORKS, type NetworkName } from "../src/networks.js";

const TEXTILE_REACTOR = "0xa9aa0a64769cbed4d3b1ceb4df01cde915c235b3";
const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = (process.env.PINHOLD_URL ?? "http://localhost:8787").replace(/\/$/, "");

interface ApiTx { kind: string; hash: Hex; chainId: number; amount: string; to: string; dryRun: boolean }
interface ApiBooking {
  id: string; state: string; channel: string; payer: string | null; priceUsdtUnits: string; priceNgnUnits: string;
  refundReason: string | null; owner: { payoutWallet: string; selfAgentId: string | null } | null; txs: ApiTx[];
}

const list = (await (await fetch(`${base}/api/bookings`)).json()) as { network: NetworkName; dryRun: boolean; agentWallet: string; bookings: ApiBooking[] };
const net = NETWORKS[list.network];
const agent = list.agentWallet.toLowerCase();
const clients = new Map<number, PublicClient>([
  [net.pay.chainId, createPublicClient({ transport: http(net.pay.rpcUrl) }) as PublicClient],
  [net.fx.chainId, createPublicClient({ transport: http(net.fx.rpcUrl) }) as PublicClient],
]);
const registryAbi = parseAbi(["function ownerOf(uint256) view returns (address)", "function isProofFresh(uint256) view returns (bool)"]);

type Transfer = { token: string; from: string; to: string; value: bigint };

async function transfers(chainId: number, hash: Hex) {
  const c = clients.get(chainId)!;
  const [rcpt, tx] = await Promise.all([c.getTransactionReceipt({ hash }), c.getTransaction({ hash })]);
  const out: Transfer[] = [];
  for (const l of rcpt.logs) {
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics });
      if (ev.eventName === "Transfer") {
        out.push({ token: l.address.toLowerCase(), from: ev.args.from.toLowerCase(), to: ev.args.to.toLowerCase(), value: ev.args.value });
      }
    } catch { /* not a Transfer */ }
  }
  return { status: rcpt.status, to: (tx.to ?? "").toLowerCase(), codes: fromDataSuffix(tx.input)?.codes ?? [], transfers: out, block: rcpt.blockNumber };
}

const stable = net.pay.stable.address.toLowerCase();
const fxStable = net.fx.stable.address.toLowerCase();
const cngn = net.fx.cngn.address.toLowerCase();
const results: Array<{ booking: string; state: string; checks: Array<{ check: string; ok: boolean; detail: string }> }> = [];
const totals = { usdtIn: 0n, cngnOut: 0n, usdtRefunded: 0n, payers: new Set<string>(), released: 0, refunded: 0, untaggedAgentTxs: 0 };
const knownPayments = new Set<string>();
let failures = 0;

for (const b of list.bookings) {
  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  const add = (check: string, ok: boolean, detail = "") => { checks.push({ check, ok, detail }); if (!ok) failures++; };
  for (const t of b.txs) {
    if (t.dryRun) { add(`${t.kind}`, true, "dry run, not on chain"); continue; }
    const r = await transfers(t.chainId, t.hash);
    if (r.status !== "success") { add(`${t.kind} mined`, false, `status ${r.status}`); continue; }
    const tagged = r.codes.length > 0;
    if (t.kind !== "payment") {
      add(`${t.kind} tagged`, tagged, r.codes.join(","));
      if (!tagged) totals.untaggedAgentTxs++;
    }
    if (t.kind === "payment") {
      knownPayments.add(t.hash.toLowerCase());
      const hit = r.transfers.find((x) => x.token === stable && x.to === agent && x.from === b.payer?.toLowerCase());
      add("payment payer -> agent", !!hit && hit.value >= BigInt(b.priceUsdtUnits), hit ? `${hit.value}` : "no matching Transfer");
      if (hit) { totals.usdtIn += hit.value; totals.payers.add(hit.from); }
    } else if (t.kind === "swap") {
      const inCngn = r.transfers.filter((x) => x.token === cngn && x.to === agent).reduce((s, x) => s + x.value, 0n);
      const outStable = r.transfers.filter((x) => x.token === fxStable && x.from === agent).reduce((s, x) => s + x.value, 0n);
      if (list.network === "mainnet") add("swap via Textile reactor", r.to === TEXTILE_REACTOR, r.to);
      add("swap delivered booked cNGN", inCngn >= BigInt(b.priceNgnUnits), `in ${inCngn} cNGN for ${outStable} stable base units`);
    } else if (t.kind === "payout") {
      const hit = r.transfers.find((x) => x.token === cngn && x.from === agent);
      const ownerWallet = b.owner?.payoutWallet.toLowerCase();
      add("payout to owner payout wallet", !!hit && hit.to === ownerWallet && hit.value === BigInt(b.priceNgnUnits), hit ? `${hit.value} -> ${hit.to}` : "none");
      if (hit) totals.cngnOut += hit.value;
      if (b.owner?.selfAgentId) {
        const c = clients.get(net.pay.chainId)!;
        const nftOwner = (await c.readContract({ address: net.self.registry, abi: registryAbi, functionName: "ownerOf", args: [BigInt(b.owner.selfAgentId)] })).toLowerCase();
        add("owner Self agent NFT owned by payout wallet", nftOwner === ownerWallet, `Self #${b.owner.selfAgentId} owner ${nftOwner}`);
      }
    } else if (t.kind === "refund" || t.kind === "surplus") {
      const hit = r.transfers.find((x) => x.token === stable && x.from === agent);
      add(`${t.kind} only to payer`, !!hit && hit.to === b.payer?.toLowerCase(), hit ? `${hit.value} -> ${hit.to}` : "none");
      if (hit) totals.usdtRefunded += hit.value;
    }
  }
  if (b.state === "RELEASED") { totals.released++; add("released has swap + payout", b.txs.some((t) => t.kind === "swap") && b.txs.some((t) => t.kind === "payout")); }
  if (b.state === "REFUNDED") { totals.refunded++; add("refunded has refund tx", b.txs.some((t) => t.kind === "refund")); }
  results.push({ booking: b.id, state: b.state, checks });
}

// Optional completeness scan: every stable transfer into the agent wallet must be a booking payment.
const scanFrom = arg("--scan");
const unaccounted: string[] = [];
if (scanFrom && !list.dryRun) {
  const c = clients.get(net.pay.chainId)!;
  const latest = await c.getBlockNumber();
  const ev = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
  for (let from = BigInt(scanFrom); from <= latest; from += 10_000n) {
    const to = from + 9_999n > latest ? latest : from + 9_999n;
    const logs = await c.getLogs({ address: net.pay.stable.address, event: ev, args: { to: list.agentWallet as Hex }, fromBlock: from, toBlock: to });
    for (const l of logs) if (!knownPayments.has(l.transactionHash.toLowerCase())) unaccounted.push(`${l.transactionHash} ${l.args.value} from ${l.args.from}`);
  }
}

for (const r of results) {
  console.log(`\n${r.booking}  ${r.state}`);
  for (const c of r.checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.check}${c.detail ? `  ${c.detail}` : ""}`);
}
const fmt = (v: bigint) => (Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
const summary = {
  network: list.network,
  agentWallet: list.agentWallet,
  bookings: list.bookings.filter((b) => b.txs.some((t) => t.kind === "payment")).length,
  released: totals.released,
  refunded: totals.refunded,
  stableIn: fmt(totals.usdtIn),
  cngnOut: fmt(totals.cngnOut),
  stableRefunded: fmt(totals.usdtRefunded),
  distinctPayers: totals.payers.size,
  untaggedAgentTxs: totals.untaggedAgentTxs,
  unaccountedIncoming: scanFrom ? unaccounted : "not scanned (pass --scan <fromBlock>)",
};
console.log(`\nSummary (from chain): ${JSON.stringify(summary, null, 2)}`);
const jsonOut = arg("--json");
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary, results }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);

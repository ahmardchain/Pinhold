// Offline end-to-end dry run. No keys, no network, no transactions.
// Runs the real API, state machine, executor and worker against mocks:
// Self identity (mock registry), Textile (fixed rate), Telegram (scripted), wallets (dry run).
//
//   npm run demo:dry
//
// Scenarios: unverified agent turned away, released booking, per-human limit across two
// agents, deleted post refund, edited post refund, never-posted refund, daily cap deferral,
// and a payout refused because the owner's Self proof does not bind the payout wallet.

import type { AddressInfo } from "node:net";
import { MockIdentity } from "../src/chain/self.js";
import { FixedRateFx } from "../src/chain/textile.js";
import { makeWallet } from "../src/chain/wallet.js";
import { readTag } from "../src/attribution.js";
import { loadConfig } from "../src/config.js";
import type { OwnerProof } from "../src/core/policy.js";
import type { Address, Owner } from "../src/core/types.js";
import { Store } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { Executor } from "../src/executor.js";
import { buildServer } from "../src/server.js";
import { ConsoleNotifier } from "../src/telegram/bot.js";
import { ScriptedProbe } from "../src/telegram/probe.js";
import { Worker } from "../src/worker.js";

const HOUR = 3_600_000;
let clock = Date.UTC(2026, 10, 23, 8, 0, 0);
const now = () => clock;
const quiet = process.argv.includes("--quiet");
const out = (s: string) => console.log(s);
const log = (s: string) => { if (!quiet) console.log(`    · ${s}`); };

const cfg = loadConfig({
  PINHOLD_NETWORK: "testnet", DRY_RUN: "true", DATABASE_PATH: ":memory:", PUBLIC_BASE_URL: "http://localhost",
  DAILY_CAP_USDT: "25", MAX_BOOKING_USDT: "10", DRY_RUN_NGN_PER_USD: "1500",
} as NodeJS.ProcessEnv);

const store = new Store(":memory:");
const AGENT_A = "0xa000000000000000000000000000000000000001";
const AGENT_A2 = "0xa000000000000000000000000000000000000002"; // same human as A
const AGENT_B = "0xb000000000000000000000000000000000000001";
const AGENT_C = "0xc000000000000000000000000000000000000001";
const STRANGER = "0xdead00000000000000000000000000000000beef";

const identity = new MockIdentity(
  new Map([
    [AGENT_A, { agentId: 11n, nullifier: 1001n }],
    [AGENT_A2, { agentId: 12n, nullifier: 1001n }],
    [AGENT_B, { agentId: 21n, nullifier: 2002n }],
    [AGENT_C, { agentId: 31n, nullifier: 3003n }],
  ]),
  new Map<string, OwnerProof>(),
);
const ownerProofs = (identity as unknown as { owners: Map<string, OwnerProof> }).owners;

function addOwner(id: string, username: string, wallet: Address, agentId: string, nftOwner: Address) {
  const o: Owner = {
    id, telegramUserId: 1, channelId: `-100${Buffer.from(username).toString("hex").slice(0, 10)}`, channelUsername: username, channelTitle: `${username} channel`,
    payoutWallet: wallet, selfAgentId: agentId, priceNgn: 5_000n * 1_000_000n, holdHours: 24, createdAt: clock,
  };
  store.saveOwner(o);
  ownerProofs.set(agentId, { agentId: BigInt(agentId), nftOwner, hasHumanProof: true, proofFresh: true });
  return o;
}
const OWNER_WALLET = "0x0000000000000000000000000000000000000a11" as Address;
addOwner("own_news", "lagosnews", OWNER_WALLET, "73", OWNER_WALLET);
// A "channel admin" whose Self agent NFT is owned by a different wallet than the payout wallet.
addOwner("own_fake", "fakedeals", "0x0000000000000000000000000000000000000bad", "74", "0x0000000000000000000000000000000000000f00");

const wallet = makeWallet({ profile: cfg.net.pay, attributionCode: "celo_test1234", dryRun: true, log });
const fxWallet = makeWallet({ profile: cfg.net.fx, attributionCode: "celo_test1234", dryRun: true, log });
const fx = new FixedRateFx(1500, "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3", now);
const probe = new ScriptedProbe();
const executor = new Executor({
  store, net: cfg.net, payWallet: wallet, fxWallet, fx, identity, channels: probe,
  dailyCap: cfg.DAILY_CAP_USDT, surplusMinReturn: cfg.SURPLUS_MIN_RETURN_USDT, now, log,
});
const engine = new Engine(store, executor, new ConsoleNotifier(log), now, log);
const worker = new Worker(store, engine, probe, 10 * 60_000, now, log);
const app = buildServer({ cfg, store, engine, identity, fx, payTo: wallet.address, now, log });

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(agent: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (agent) { headers["x-self-agent-signature"] = agent; headers["x-self-agent-timestamp"] = String(clock); }
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function advance(hours: number, stepMinutes = 10) {
  const end = clock + hours * HOUR;
  while (clock < end) {
    clock = Math.min(end, clock + stepMinutes * 60_000);
    await worker.tick();
  }
}

async function book(agent: string, channel: string, text: string) {
  const q = await call(agent, "POST", "/api/bookings", { channel, text });
  if (q.status !== 201) return { id: null as string | null, q };
  const p = await call(agent, "POST", `/api/bookings/${q.json.id}/pay`);
  if (p.status !== 200) throw new Error(`pay failed ${p.status} ${JSON.stringify(p.json)}`);
  return { id: q.json.id as string, q };
}

async function post(id: string, messageId: number, text?: string) {
  const b = store.getBooking(id)!;
  await engine.apply(id, { type: "POST_SEEN", messageId, text: text ?? b.postText });
}

let failures = 0;
function expect(label: string, ok: boolean, detail = "") {
  out(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const TEXT = "Open a free account with Acme Bank this week.\nhttps://acme.example/ng";

try {
  out("\n1. Unverified agent asks for a booking");
  const r1 = await call(STRANGER, "POST", "/api/bookings", { channel: "@lagosnews", text: TEXT });
  expect("turned away with 401", r1.status === 401, r1.json.error);
  const r1b = await call(null, "POST", "/api/bookings", { channel: "@lagosnews", text: TEXT });
  expect("unsigned request turned away with 401", r1b.status === 401);

  out("\n2. Verified agent A books, owner posts, post stays up 24 h");
  const a = await book(AGENT_A, "@lagosnews", TEXT);
  expect("quote issued", a.q.status === 201, `${a.q.json.price?.display} ${a.q.json.price?.asset} for ₦${a.q.json.priceNgn}`);
  expect("x402 payment funds escrow", store.getBooking(a.id!)!.state === "PAID");

  out("\n3. Agent A2 (same human as A) tries a second booking while A's is open");
  const r3 = await call(AGENT_A2, "POST", "/api/bookings", { channel: "@lagosnews", text: "Second ad" });
  expect("refused: one open escrow per human across agents", r3.status === 409, r3.json.error);

  await advance(1);
  await post(a.id!, 501);
  expect("post seen, text matches, hold starts", store.getBooking(a.id!)!.state === "LIVE");
  await advance(24.5);
  const ra = store.getBooking(a.id!)!;
  expect("released after the hold window", ra.state === "RELEASED", `swap ${ra.swapTx?.slice(0, 10)}…, payout ${ra.payoutTx?.slice(0, 10)}…`);
  const payout = store.getTx(a.id!, "payout")!;
  expect("cNGN paid only to the verified owner wallet", payout.to === OWNER_WALLET && payout.amount === 5_000_000_000n);
  const builtA = [...wallet.built, ...fxWallet.built];
  expect("every tx built so far ends with the ERC-8021 tag", builtA.length > 0 && builtA.every((t) => readTag(t.data).includes("celo_test1234")),
    `${builtA.length} txs: ${builtA.map((t) => t.label.split(" ")[0]).join(", ")}`);

  out("\n4. Agent B books; the owner deletes the post after 3 h");
  const b = await book(AGENT_B, "@lagosnews", "Shop the Harmattan sale at Bata.\nhttps://bata.example");
  await post(b.id!, 502);
  await advance(3);
  probe.deleted.add(b.id!);
  await advance(0.5);
  const rb = store.getBooking(b.id!)!;
  expect("refunded after two missed checks", rb.state === "REFUNDED" && rb.refundReason === "deleted");
  expect("refund went only to the payer", store.getTx(b.id!, "refund")!.to === rb.payer);

  out("\n5. Agent C books; the owner edits the post to different text");
  const c = await book(AGENT_C, "@lagosnews", "Learn to code with Example Academy.");
  await post(c.id!, 503);
  await engine.apply(c.id!, { type: "POST_EDITED", messageId: 503, text: "Learn to code with Rival Academy." });
  const rc = store.getBooking(c.id!)!;
  expect("refunded on edit", rc.state === "REFUNDED" && rc.refundReason === "edited");

  out("\n6. Agent A books again; the owner never posts");
  const a2 = await book(AGENT_A, "@lagosnews", "Never posted ad");
  await advance(12.5, 30);
  const ra2 = store.getBooking(a2.id!)!;
  expect("refunded after the post deadline", ra2.state === "REFUNDED" && ra2.refundReason === "never_posted");

  out("\n7. Fake admin: owner's Self agent NFT is not owned by the payout wallet");
  const r7 = await call(AGENT_B, "POST", "/api/bookings", { channel: "@fakedeals", text: "Any ad" });
  expect("booking refused up front: owner not verified", r7.status === 403, r7.json.error);
  // Owner passes at booking time, then the binding breaks before payout.
  const d = await book(AGENT_B, "@lagosnews", "Ad for a channel whose owner loses verification");
  await post(d.id!, 504);
  ownerProofs.set("73", { agentId: 73n, nftOwner: "0x0000000000000000000000000000000000000f00", hasHumanProof: true, proofFresh: true });
  await advance(24.5);
  const rd = store.getBooking(d.id!)!;
  expect("payout refused at release, sponsor refunded", rd.state === "REFUNDED" && rd.refundReason === "owner_unverified");
  ownerProofs.set("73", { agentId: 73n, nftOwner: OWNER_WALLET, hasHumanProof: true, proofFresh: true });

  out("\n8. Daily outflow cap");
  const spent = store.outflowSince(Date.UTC(new Date(clock).getUTCFullYear(), new Date(clock).getUTCMonth(), new Date(clock).getUTCDate()));
  out(`    spent today so far: ${Number(spent) / 1e6} of ${Number(cfg.DAILY_CAP_USDT) / 1e6}`);
  // Fill most of today's cap with one more release, then the next one must wait.
  const e1 = await book(AGENT_C, "@lagosnews", "Cap test ad one");
  const e2 = await book(AGENT_A, "@lagosnews", "Cap test ad two");
  await post(e1.id!, 505); await post(e2.id!, 506);
  (executor as unknown as { d: { dailyCap: bigint } }).d.dailyCap = 4_000_000n; // one ~3.34 swap fits per day, two do not
  await advance(24.5);
  const s1 = store.getBooking(e1.id!)!, s2 = store.getBooking(e2.id!)!;
  const deferred = [s1, s2].filter((x) => x.state === "RELEASING" && x.deferredUntil);
  expect("one release fits, the other is deferred to the next UTC day", deferred.length >= 1, deferred.map((x) => x.id).join(","));
  await advance(24, 60);
  expect("deferred payout goes out after the cap resets", [store.getBooking(e1.id!)!, store.getBooking(e2.id!)!].every((x) => x.state === "RELEASED"));

  out("\nReceipt for the released booking:");
  out(`  ${cfg.PUBLIC_BASE_URL}/r/${a.id}`);
  for (const t of store.timeline(a.id!)) out(`    ${new Date(t.at).toISOString().slice(0, 16)}  ${t.text}`);
  const stats = await call(null, "GET", "/api/stats");
  out(`\nStats: ${JSON.stringify(stats.json)}`);
} finally {
  server.close();
}

out(failures ? `\n${failures} check(s) FAILED` : "\nAll dry-run checks passed. No transaction was sent.");
process.exit(failures ? 1 : 0);

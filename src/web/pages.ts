// Server-rendered public pages: a receipt per booking and the stats page.
// Plain HTML + inline CSS, light and dark, readable on a phone.

import type { Booking, Owner } from "../core/types.js";
import type { Config } from "../config.js";
import type { TimelineEntry, TxRecord } from "../db.js";
import type { Stats } from "./stats.js";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const money = (units: bigint | null, sym: string) =>
  units === null ? "—" : `${(Number(units) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${sym}`;

const STATE_LABEL: Record<Booking["state"], string> = {
  QUOTED: "Quoted, awaiting payment",
  PAID: "Paid, awaiting post",
  LIVE: "Live, hold window running",
  RELEASING: "Releasing payout",
  RELEASED: "Released to channel owner",
  REFUNDING: "Refunding sponsor",
  REFUNDED: "Refunded to sponsor",
  EXPIRED: "Quote expired, nothing moved",
};

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f7f6f2;--fg:#1c1c1a;--muted:#6b6a64;--card:#fff;--line:#e4e2da;--ok:#1f7a4d;--bad:#b3392f;--accent:#2f5fb3}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a09f98;--card:#1d1d1b;--line:#2e2e2b;--ok:#4cc38a;--bad:#ef7a6f;--accent:#7ea6f0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.05rem;margin:28px 0 8px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid var(--line);font-size:.85rem}
.ok{color:var(--ok)}.bad{color:var(--bad)}a{color:var(--accent);word-break:break-all}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}dt{color:var(--muted)}dd{margin:0}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font:inherit}
ol{padding-left:20px;margin:0}li{margin:4px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.n{font-size:1.6rem;font-weight:650}.banner{background:#fff3cd;color:#5c4400;border-radius:8px;padding:8px 12px;margin:8px 0}
@media (prefers-color-scheme:dark){.banner{background:#3a3010;color:#f3dc8a}}
</style></head><body><main>${body}</main></body></html>`;
}

function txLink(t: TxRecord, cfg: Config): string {
  if (t.dryRun) return `<span class="muted">dry run, not sent</span> <code>${t.hash.slice(0, 12)}…</code>`;
  const chain = t.chainId === cfg.net.pay.chainId ? cfg.net.pay : cfg.net.fx;
  return `<a href="${chain.explorerTx(t.hash)}">${t.hash.slice(0, 10)}…${t.hash.slice(-6)}</a>`;
}

const TX_LABEL: Record<TxRecord["kind"], string> = {
  payment: "Sponsor payment (x402)",
  approve: "Approve Textile reactor",
  swap: "Textile swap USD₮ → cNGN",
  payout: "cNGN payout to owner",
  surplus: "Rate buffer returned to payer",
  refund: "Refund to payer",
};

export function renderReceipt(b: Booking, owner: Owner | null, timeline: TimelineEntry[], txs: TxRecord[], cfg: Config): string {
  const sym = cfg.net.pay.stable.symbol;
  const postUrl = b.channelUsername && b.messageId ? `https://t.me/${b.channelUsername}/${b.messageId}` : null;
  const allTx = txs;
  const stateClass = b.state === "RELEASED" ? "ok" : b.state === "REFUNDED" ? "bad" : "";
  const body = `
<p class="muted">Pinhold receipt</p>
<h1>Booking ${esc(b.id)}</h1>
<p><span class="pill ${stateClass}">${STATE_LABEL[b.state]}</span>${b.refundReason ? ` <span class="muted">reason: ${esc(b.refundReason)}</span>` : ""}</p>
${cfg.DRY_RUN ? `<div class="banner">Dry run on ${esc(cfg.net.name)}: transactions were built and tagged but not sent.</div>` : ""}
${cfg.net.name === "testnet" && !cfg.DRY_RUN ? `<div class="banner">Testnet: test tokens with no value.</div>` : ""}
<div class="card"><dl>
<dt>Channel</dt><dd>${esc(owner?.channelTitle ?? b.channelId)}${b.channelUsername ? ` (@${esc(b.channelUsername)})` : ""}</dd>
<dt>Post</dt><dd>${postUrl ? `<a href="${postUrl}">${postUrl}</a>` : '<span class="muted">not posted yet</span>'}</dd>
<dt>Hold window</dt><dd>${b.holdHours} h${b.holdEndsAt ? `, until ${new Date(b.holdEndsAt).toUTCString()}` : ""}</dd>
<dt>Owner receives</dt><dd>₦${(Number(b.priceNgn) / 1e6).toLocaleString("en-US")} in cNGN</dd>
<dt>Sponsor paid</dt><dd>${money(b.priceUsdt, sym)}</dd>
<dt>Sponsor agent</dt><dd>Self Agent ID #${esc(b.sponsorAgentId)}</dd>
<dt>Owner identity</dt><dd>${owner?.selfAgentId ? `Self Agent ID #${esc(owner.selfAgentId)}, payout wallet <a href="${cfg.net.fx.explorerAddress(owner.payoutWallet)}">${owner.payoutWallet.slice(0, 8)}…</a>` : "—"}</dd>
</dl></div>
<h2>Booked text</h2><div class="card"><pre>${esc(b.postText)}</pre></div>
<h2>Transactions</h2><div class="card">${allTx.length ? `<dl>${allTx.map((t) => `<dt>${TX_LABEL[t.kind]}</dt><dd>${txLink(t, cfg)}</dd>`).join("")}</dl>` : '<span class="muted">None yet.</span>'}</div>
<h2>Check timeline</h2><div class="card"><ol>${timeline.map((e) => `<li><span class="muted">${new Date(e.at).toISOString().replace("T", " ").slice(0, 16)} UTC</span> ${esc(e.text)}</li>`).join("")}</ol></div>
<p class="muted">Release or refund is decided by deterministic code from these checks. Every Pinhold transaction carries an ERC-8021 attribution tag. Rebuild this receipt from the chain with <code>npm run verify</code>.</p>`;
  return layout(`Pinhold receipt ${b.id}`, body);
}

export function renderStats(s: Stats, cfg: Config): string {
  const sym = cfg.net.pay.stable.symbol;
  const tile = (label: string, value: string) => `<div class="card"><div class="n">${esc(value)}</div><div class="muted">${esc(label)}</div></div>`;
  const body = `
<p class="muted">Pinhold</p><h1>Live stats</h1>
<p class="muted">Network: ${esc(cfg.net.name)}${cfg.DRY_RUN ? " (dry run)" : ""}</p>
<div class="grid">
${tile("Paid bookings", String(s.bookings))}
${tile("Released", String(s.released))}
${tile("Refunded", String(s.refunded))}
${tile("Open escrows", String(s.open))}
${tile(`${sym} in`, money(s.usdtIn, ""))}
${tile("cNGN paid to owners", `₦${(Number(s.cngnOut) / 1e6).toLocaleString("en-US")}`)}
${tile(`${sym} refunded`, money(s.usdtRefunded, ""))}
${tile("Distinct paying wallets", String(s.distinctPayers))}
${tile("Distinct verified humans", String(s.distinctSponsorHumans))}
${tile("Channels", String(s.channels))}
</div>
<p class="muted">Every number here can be rebuilt from chain data with <code>npm run verify</code>.</p>`;
  return layout("Pinhold stats", body);
}

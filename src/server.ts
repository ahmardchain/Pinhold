// HTTP API for sponsors' agents, plus public receipts and stats.
//
//   POST /api/bookings          Self-signed. Verified agent -> quote. Unverified -> 401.
//   POST /api/bookings/:id/pay  Self-signed AND x402-paid (USD₮ to Pinhold's payTo wallet).
//   GET  /api/bookings/:id      Booking JSON (public).
//   GET  /api/channels          Listed channels and prices (public).
//   GET  /r/:id                 Public receipt page.
//   GET  /stats                 Public stats page.
//
// Order matters on the pay route: the Self check runs before x402, so an unverified agent
// is refused before it is ever asked to pay.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import type { Hex } from "viem";
import { admitBooking, sponsorPrice, type SponsorIdentity } from "./core/policy.js";
import type { Address, Booking } from "./core/types.js";
import type { IdentityService } from "./chain/self.js";
import type { FxProvider } from "./chain/textile.js";
import { dryRunHash } from "./chain/wallet.js";
import type { Config } from "./config.js";
import type { Store } from "./db.js";
import type { Engine } from "./engine.js";
import { renderReceipt, renderStats } from "./web/pages.js";
import { computeStats } from "./web/stats.js";

type RawReq = Request & { rawBody?: Buffer; sponsor?: SponsorIdentity };

export interface ServerDeps {
  cfg: Config;
  store: Store;
  engine: Engine;
  identity: IdentityService;
  fx: FxProvider;
  payTo: Address;
  now: () => number;
  log: (line: string) => void;
}

const HOUR = 3_600_000;

export function newBookingId(): string {
  return `bk_${randomBytes(6).toString("hex")}`;
}

export function buildServer(d: ServerDeps) {
  const { cfg, store } = d;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({
    limit: "32kb",
    verify: (req, _res, buf) => {
      (req as RawReq).rawBody = Buffer.from(buf); // Self signatures cover the raw bytes
    },
  }));

  // ---------- Self Agent ID gate (who gets served) ----------
  const requireSelfAgent = async (req: RawReq, res: Response, next: NextFunction) => {
    try {
      const sponsor = await d.identity.verifySponsor({
        signature: req.header("x-self-agent-signature") ?? "",
        timestamp: req.header("x-self-agent-timestamp") ?? "",
        method: req.method,
        url: req.originalUrl,
        body: req.rawBody?.toString("utf8") ?? "",
      });
      if (!sponsor.valid) {
        d.log(`Turned away unverified agent ${sponsor.agentAddress || "(no signature)"}: ${sponsor.error ?? "not verified"}`);
        res.status(401).json({
          error: "agent_not_verified",
          message: "Pinhold only serves agents backed by a Self Agent ID proof of human.",
          detail: sponsor.error ?? null,
          howToFix: "Register your agent at https://docs.self.xyz/docs/agent-id/quickstart/ and sign requests with @selfxyz/agent-sdk.",
        });
        return;
      }
      req.sponsor = sponsor;
      next();
    } catch (e) {
      res.status(503).json({ error: "verification_unavailable", message: (e as Error).message });
    }
  };

  // ---------- quote ----------
  app.post("/api/bookings", requireSelfAgent, async (req: RawReq, res) => {
    const sponsor = req.sponsor!;
    const body = req.body as { channel?: string; text?: string };
    const owner = body.channel ? store.ownerByChannel(String(body.channel)) : null;
    const ownerProof = owner?.selfAgentId ? await d.identity.ownerProof(owner.selfAgentId) : null;
    const ownerVerified = !!owner && !!ownerProof && ownerProof.hasHumanProof && ownerProof.proofFresh &&
      ownerProof.nftOwner.toLowerCase() === owner.payoutWallet.toLowerCase();

    let priceUsdt = 0n;
    if (owner) {
      const est = await d.fx.previewExactOut(owner.priceNgn).catch(() => null);
      if (est === null) {
        res.status(503).json({ error: "no_fx_quote", message: "Textile has no USD₮→cNGN quote right now; try again shortly." });
        return;
      }
      priceUsdt = sponsorPrice(est, cfg.FX_BUFFER_BPS);
    }

    const verdict = admitBooking({
      sponsor,
      openEscrowsForHuman: store.openBookingsForHuman(sponsor.nullifier.toString()),
      maxOpenEscrowsPerHuman: cfg.MAX_OPEN_ESCROWS_PER_HUMAN,
      owner,
      ownerVerified,
      postText: String(body.text ?? ""),
      priceUsdt,
      maxBookingUsdt: cfg.MAX_BOOKING_USDT,
      minBookingUsdt: cfg.MIN_BOOKING_USDT,
    });
    if (!verdict.ok) {
      d.log(`Refused booking from agent ${sponsor.agentId}: ${verdict.code}`);
      res.status(verdict.status).json({ error: verdict.code, message: verdict.message });
      return;
    }

    const now = d.now();
    const b: Booking = {
      id: newBookingId(),
      state: "QUOTED",
      channelId: owner!.channelId,
      channelUsername: owner!.channelUsername,
      ownerId: owner!.id,
      postText: String(body.text).trim(),
      holdHours: owner!.holdHours,
      priceNgn: owner!.priceNgn,
      priceUsdt,
      sponsorAgentId: sponsor.agentId.toString(),
      sponsorAgentAddress: sponsor.agentAddress as Address,
      sponsorNullifier: sponsor.nullifier.toString(),
      payer: null, paymentTx: null, messageId: null, postSeenAt: null, missedChecks: 0,
      createdAt: now,
      quoteExpiresAt: now + 30 * 60_000,
      postDeadline: now + cfg.POST_DEADLINE_HOURS * HOUR,
      holdEndsAt: null, refundReason: null, swapTx: null, payoutTx: null, surplusTx: null, refundTx: null,
      cngnPaid: null, usdtSpent: null, deferredUntil: null, updatedAt: now,
    };
    store.saveBooking(b);
    store.log(b.id, now, `Quoted to Self agent #${b.sponsorAgentId}: ₦${fmt(b.priceNgn)} for ${b.holdHours} h on ${owner!.channelTitle}, ${fmt(b.priceUsdt)} ${cfg.net.pay.stable.symbol}`);
    res.status(201).json(publicBooking(b, cfg));
  });

  const recordPayment = (b: Booking, tx: Hex, payer: Address, amount: bigint, dryRun: boolean) => {
    store.recordTx({
      bookingId: b.id, kind: "payment", hash: tx, chainId: cfg.net.pay.chainId, token: cfg.net.pay.stable.address,
      amount, to: d.payTo, dryRun, at: d.now(),
    });
  };

  // ---------- pay (Self first, then x402) ----------
  const bookingForPay = (req: Request, res: Response, next: NextFunction) => {
    const b = store.getBooking(req.params.id as string);
    const sponsor = (req as RawReq).sponsor!;
    if (!b) return void res.status(404).json({ error: "unknown_booking" });
    if (b.sponsorAgentId !== sponsor.agentId.toString()) {
      return void res.status(403).json({ error: "not_your_booking", message: "Only the agent that requested this quote can pay it." });
    }
    if (b.state !== "QUOTED") return void res.status(409).json({ error: "not_payable", state: b.state });
    if (d.now() >= b.quoteExpiresAt) return void res.status(409).json({ error: "quote_expired" });
    next();
  };

  const payHandler = (req: Request, res: Response) => {
    // With x402 this runs after verify and before settle; PAYMENT_SETTLED fires in onAfterSettle.
    res.json({ ok: true, booking: req.params.id, receipt: `${cfg.PUBLIC_BASE_URL}/r/${req.params.id}` });
  };

  if (cfg.DRY_RUN) {
    app.post("/api/bookings/:id/pay", requireSelfAgent, bookingForPay, async (req: RawReq, res) => {
      const b = store.getBooking(req.params.id as string)!;
      const tx = dryRunHash(`x402:${b.id}`, "0x");
      recordPayment(b, tx, b.sponsorAgentAddress, b.priceUsdt, true);
      await d.engine.apply(b.id, { type: "PAYMENT_SETTLED", payer: b.sponsorAgentAddress, tx, amount: b.priceUsdt });
      res.json({ ok: true, dryRun: true, booking: b.id, tx, receipt: `${cfg.PUBLIC_BASE_URL}/r/${b.id}` });
    });
  } else {
    const facilitator = new HTTPFacilitatorClient({
      url: cfg.net.pay.facilitatorUrl,
      createAuthHeaders: async () => {
        const h = { "X-API-Key": cfg.X402_API_KEY! };
        return { verify: h, settle: h, supported: h };
      },
    });
    const resourceServer = new x402ResourceServer(facilitator);
    resourceServer.register("eip155:*", new ExactEvmScheme());
    resourceServer.onAfterSettle(async (ctx) => {
      const url = ctx.paymentPayload.resource?.url ?? "";
      const id = /\/api\/bookings\/([^/]+)\/pay/.exec(url)?.[1];
      if (!id || !ctx.result.success || !ctx.result.payer) {
        d.log(`x402 settle without a booking id: ${url}`);
        return;
      }
      const b = store.getBooking(id);
      if (b) recordPayment(b, ctx.result.transaction as Hex, ctx.result.payer as Address, BigInt(ctx.requirements.amount), false);
      await d.engine.apply(id, {
        type: "PAYMENT_SETTLED",
        payer: ctx.result.payer as Address,
        tx: ctx.result.transaction as Hex,
        amount: BigInt(ctx.requirements.amount),
      });
    });
    const stable = cfg.net.pay.stable;
    const routes = {
      "POST /api/bookings/:id/pay": {
        accepts: {
          scheme: "exact",
          network: cfg.net.pay.x402Network,
          payTo: d.payTo,
          maxTimeoutSeconds: 300,
          price: (ctx: { path: string }) => {
            const id = /\/api\/bookings\/([^/]+)\/pay/.exec(ctx.path)?.[1] ?? "";
            const b = store.getBooking(id);
            if (!b) throw new Error("unknown booking");
            return { amount: b.priceUsdt.toString(), asset: stable.address, extra: { name: stable.eip712Name, version: stable.eip712Version } };
          },
        },
        description: "Pinhold ad escrow: held until the post completes its hold window, then paid to the channel owner in cNGN",
        mimeType: "application/json",
      },
    };
    app.post("/api/bookings/:id/pay", requireSelfAgent, bookingForPay,
      paymentMiddleware(routes as never, resourceServer), payHandler);
  }

  // ---------- public reads ----------
  app.get("/api/bookings/:id", (req, res) => {
    const b = store.getBooking(req.params.id);
    if (!b) return void res.status(404).json({ error: "unknown_booking" });
    res.json({ ...publicBooking(b, cfg), timeline: store.timeline(b.id), txs: store.txs(b.id).map(serializeTx) });
  });

  // Everything `npm run verify` needs to rebuild each booking from the chain.
  app.get("/api/bookings", (_req, res) => {
    res.json({
      network: cfg.net.name,
      dryRun: cfg.DRY_RUN,
      agentWallet: d.payTo,
      bookings: store.listBookings().map((b) => {
        const o = store.getOwner(b.ownerId);
        return {
          ...publicBooking(b, cfg),
          payer: b.payer,
          sponsorAgentId: b.sponsorAgentId,
          priceUsdtUnits: b.priceUsdt.toString(),
          priceNgnUnits: b.priceNgn.toString(),
          owner: o ? { payoutWallet: o.payoutWallet, selfAgentId: o.selfAgentId, channelTitle: o.channelTitle } : null,
          txs: store.txs(b.id).map(serializeTx),
        };
      }),
    });
  });

  app.get("/api/channels", (_req, res) => {
    res.json(store.listOwners().filter((o) => o.selfAgentId).map((o) => ({
      channel: o.channelUsername ? `@${o.channelUsername}` : o.channelId,
      title: o.channelTitle,
      priceNgn: fmt(o.priceNgn),
      holdHours: o.holdHours,
    })));
  });

  app.get("/api/stats", (_req, res) => res.json(jsonSafe(computeStats(store))));
  app.get("/stats", (_req, res) => res.type("html").send(renderStats(computeStats(store), cfg)));
  app.get("/r/:id", (req, res) => {
    const b = store.getBooking(req.params.id);
    if (!b) return void res.status(404).type("text").send("Unknown booking");
    res.type("html").send(renderReceipt(b, store.getOwner(b.ownerId), store.timeline(b.id), store.txs(b.id), cfg));
  });
  // ERC-8004 registration file (agentURI) for Pinhold's own agent identity.
  const registration = (_req: Request, res: Response) => res.json(agentRegistration(cfg, d.payTo));
  app.get("/agent.json", registration);
  const icon = readFileSync(new URL("./web/icon.svg", import.meta.url));
  app.get("/icon.svg", (_req, res) => res.type("image/svg+xml").send(icon));
  app.get("/.well-known/agent-registration.json", registration);

  app.get("/healthz", (_req, res) => res.json({ ok: true, network: cfg.net.name, dryRun: cfg.DRY_RUN }));

  return app;
}

export function agentRegistration(cfg: Config, wallet: Address) {
  const ids = (process.env.ERC8004_AGENT_ID ? [{ agentId: Number(process.env.ERC8004_AGENT_ID), agentRegistry: `eip155:${cfg.net.pay.chainId}:${cfg.net.erc8004IdentityRegistry}` }] : []);
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Pinhold",
    description: "Escrow agent for Telegram channel ad placements. A sponsor's Self-verified agent pays USD₮ over x402; Pinhold watches the post through its hold window, then swaps to cNGN on Textile FX and pays the Self-verified channel owner, or refunds the payer if the post never went up, was deleted or was edited.",
    image: `${cfg.PUBLIC_BASE_URL}/icon.svg`,
    services: [
      { name: "web", endpoint: cfg.PUBLIC_BASE_URL },
      { name: "booking-api", endpoint: `${cfg.PUBLIC_BASE_URL}/api/bookings`, payment: "x402", auth: "Self Agent ID" },
    ],
    x402Support: true,
    active: true,
    registrations: ids,
    supportedTrust: ["reputation"],
    wallet,
    contact: { x: "@Ahmardchain", email: "ahmardchain@gmail.com", source: `https://github.com/${cfg.GITHUB_REPO}` },
  };
}

export function fmt(units: bigint, decimals = 6): string {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const whole = v / 10n ** BigInt(decimals);
  const frac = (v % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").slice(0, 2);
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}.${frac}`;
}

function publicBooking(b: Booking, cfg: Config) {
  return {
    id: b.id,
    state: b.state,
    channel: b.channelUsername ? `@${b.channelUsername}` : b.channelId,
    postText: b.postText,
    holdHours: b.holdHours,
    priceNgn: fmt(b.priceNgn),
    price: { amount: b.priceUsdt.toString(), display: fmt(b.priceUsdt), asset: cfg.net.pay.stable.symbol },
    payUrl: `${cfg.PUBLIC_BASE_URL}/api/bookings/${b.id}/pay`,
    receiptUrl: `${cfg.PUBLIC_BASE_URL}/r/${b.id}`,
    quoteExpiresAt: new Date(b.quoteExpiresAt).toISOString(),
    postDeadline: new Date(b.postDeadline).toISOString(),
    refundReason: b.refundReason,
  };
}

function serializeTx(t: { amount: bigint }) {
  return { ...t, amount: t.amount.toString() };
}

function jsonSafe<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

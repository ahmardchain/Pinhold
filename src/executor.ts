// Runs the state machine's money actions. Every step is idempotent: a tx row is written
// (with the signed raw tx) before broadcast, so a restart resumes instead of paying twice.
// The machine decides WHETHER to release or refund; this file only decides HOW, and it can
// still refuse (owner not verified, daily cap reached), which goes back to the machine as an event.

import type { Hex } from "viem";
import { checkDailyCap, payoutTarget, refundTarget, surplus, utcDayStart } from "./core/policy.js";
import type { Address, Booking, BookingEvent, Owner } from "./core/types.js";
import type { IdentityService } from "./chain/self.js";
import type { FxProvider } from "./chain/textile.js";
import { approveData, type ChainWallet, transferData } from "./chain/wallet.js";
import type { Store, TxKind } from "./db.js";
import type { NetworkProfile } from "./networks.js";

export interface ChannelProbe {
  isChannelAdmin(owner: Owner): Promise<boolean>;
}

export interface ExecutorDeps {
  store: Store;
  net: NetworkProfile;
  payWallet: ChainWallet; // escrow chain (x402 in, refunds out)
  fxWallet: ChainWallet; // FX chain (swap, cNGN payout). Same wallet on mainnet.
  fx: FxProvider;
  identity: IdentityService;
  channels: ChannelProbe;
  dailyCap: bigint;
  surplusMinReturn: bigint;
  now: () => number;
  log: (line: string) => void;
}

export class Executor {
  constructor(private readonly d: ExecutorDeps) {}

  private spentToday(): bigint {
    return this.d.store.outflowSince(utcDayStart(this.d.now()));
  }

  /** Send one step once. Returns the existing hash if the step already ran. */
  private async step(
    b: Booking, kind: TxKind, wallet: ChainWallet, token: Address, amount: bigint, to: Address,
    req: { to: Address; data: Hex; label: string },
  ): Promise<Hex> {
    const existing = this.d.store.getTx(b.id, kind);
    if (existing) {
      const raw = this.d.store.get(`raw:${b.id}:${kind}`);
      if (raw && !existing.dryRun) await wallet.rebroadcast(raw as Hex);
      if ((await wallet.waitFor(existing.hash as Hex)) !== "success") throw new Error(`${kind} tx ${existing.hash} reverted`);
      return existing.hash as Hex;
    }
    const sent = await wallet.send(req, (hash, raw) => {
      this.d.store.recordTx({
        bookingId: b.id, kind, hash, chainId: wallet.chainId, token, amount, to, dryRun: wallet.dryRun, at: this.d.now(),
      });
      if (raw) this.d.store.set(`raw:${b.id}:${kind}`, raw);
    });
    if ((await wallet.waitFor(sent.hash)) !== "success") throw new Error(`${kind} tx ${sent.hash} reverted`);
    return sent.hash;
  }

  async release(b: Booking): Promise<BookingEvent> {
    const { store, net, fxWallet, payWallet } = this.d;
    const owner = store.getOwner(b.ownerId);
    if (!owner) return { type: "OWNER_REJECTED", reason: "owner_unverified" };

    // 1. Who can be paid: registry read + channel admin check, right before money moves.
    const [proof, isAdmin] = await Promise.all([
      owner.selfAgentId ? this.d.identity.ownerProof(owner.selfAgentId) : Promise.resolve(null),
      this.d.channels.isChannelAdmin(owner),
    ]);
    const target = payoutTarget(owner, proof, isAdmin);
    if (!target.ok) return { type: "OWNER_REJECTED", reason: target.reason };

    // 2. Textile exact-output swap: USD₮ -> exactly priceNgn cNGN, into our own wallet.
    let swapTx = store.getTx(b.id, "swap");
    if (!swapTx) {
      const quote = await this.d.fx.requestExactOut(b.priceNgn, fxWallet.address);
      if (!quote) return { type: "FX_UNAVAILABLE" };
      const cap = checkDailyCap(this.spentToday(), quote.takerPays, this.d.dailyCap, this.d.now());
      if (!cap.ok) return { type: "DEFERRED", until: cap.retryAt };

      const allowance = await fxWallet.erc20Allowance(net.fx.stable.address, quote.reactor);
      if (allowance < quote.takerPaysRaw && !store.getTx(b.id, "approve")) {
        await this.step(b, "approve", fxWallet, net.fx.stable.address, 0n, quote.reactor, {
          to: net.fx.stable.address,
          data: approveData(quote.reactor, quote.takerPaysRaw),
          label: `approve ${quote.takerPaysRaw} ${net.fx.stable.symbol} base units to Textile reactor`,
        });
      }
      if (this.d.now() >= quote.expiresAt) return { type: "FX_UNAVAILABLE" }; // re-quote on the next tick
      const hash = await this.step(b, "swap", fxWallet, net.fx.stable.address, quote.takerPays, fxWallet.address, {
        to: quote.swap.to,
        data: quote.swap.data,
        label: `Textile swap ${quote.takerPaysRaw} ${net.fx.stable.symbol} base units -> ${b.priceNgn} cNGN (${quote.rfqId})`,
      });
      await this.d.fx.submit(quote, hash);
      swapTx = store.getTx(b.id, "swap")!;
    }

    // 3. cNGN payout to the verified owner's wallet.
    const payoutHash = await this.step(b, "payout", fxWallet, net.fx.cngn.address, b.priceNgn, target.to, {
      to: net.fx.cngn.address,
      data: transferData(target.to, b.priceNgn),
      label: `pay ${b.priceNgn} cNGN to owner ${target.to}`,
    });

    // 4. Rate buffer left over goes back to the payer (and only the payer).
    let surplusHash = (store.getTx(b.id, "surplus")?.hash ?? null) as Hex | null;
    const left = surplus(b.priceUsdt, swapTx.amount, this.d.surplusMinReturn);
    if (!surplusHash && left > 0n) {
      const cap = checkDailyCap(this.spentToday(), left, this.d.dailyCap, this.d.now());
      if (cap.ok) {
        const to = refundTarget(b);
        surplusHash = await this.step(b, "surplus", payWallet, net.pay.stable.address, left, to, {
          to: net.pay.stable.address,
          data: transferData(to, left),
          label: `return ${left} ${net.pay.stable.symbol} rate buffer to payer ${to}`,
        });
      } else {
        this.d.log(`Booking ${b.id}: surplus ${left} kept until the cap resets`);
      }
    }

    return {
      type: "RELEASE_DONE",
      swapTx: swapTx.hash as Hex,
      payoutTx: payoutHash,
      surplusTx: surplusHash,
      cngnPaid: b.priceNgn,
      usdtSpent: swapTx.amount,
    };
  }

  async refund(b: Booking): Promise<BookingEvent> {
    const { net, payWallet } = this.d;
    const to = refundTarget(b); // throws if there is no payer: nothing to refund
    if (!this.d.store.getTx(b.id, "refund")) {
      const cap = checkDailyCap(this.spentToday(), b.priceUsdt, this.d.dailyCap, this.d.now());
      if (!cap.ok) return { type: "DEFERRED", until: cap.retryAt };
    }
    const hash = await this.step(b, "refund", payWallet, net.pay.stable.address, b.priceUsdt, to, {
      to: net.pay.stable.address,
      data: transferData(to, b.priceUsdt),
      label: `refund ${b.priceUsdt} ${net.pay.stable.symbol} to payer ${to}`,
    });
    return { type: "REFUND_DONE", refundTx: hash };
  }
}

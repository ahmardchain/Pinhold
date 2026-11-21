// Textile FX RFQ v2 client: exact-output quotes (buyAmount = the owner's naira price).
// Docs: https://fx-docs.textilecredit.com/api/v2/rfq.html
//
// Flow: preview (free, for pricing) → request (firm, ~60 s TTL, bound to our wallet)
// → approve takerPays to the reactor if needed → broadcast transactions.swap with our
// ERC-8021 tag appended → report the hash. Output lands in our wallet (the taker).

import { type Hex, keccak256, toHex } from "viem";
import type { Address } from "../core/types.js";

export interface FxQuote {
  rfqId: string;
  claimToken: string;
  buyAmount: bigint; // cNGN we receive (exact)
  takerPays: bigint; // USD₮ that leaves our wallet, fee included, in 6-decimal USD units (rounded up)
  takerPaysRaw: bigint; // the same amount in the sell token's own decimals (what we approve)
  feeAmount: bigint;
  expiresAt: number; // unix ms, accept cutoff
  reactor: Address;
  swap: { to: Address; data: Hex };
}

export interface FxProvider {
  /** Indicative USD₮ cost (6-decimal USD units) of buying exactly `buyAmount` cNGN. null when nobody would quote. */
  previewExactOut(buyAmount: bigint): Promise<bigint | null>;
  /** Firm exact-output quote bound to `taker`. null on no_quote. */
  requestExactOut(buyAmount: bigint, taker: Address): Promise<FxQuote | null>;
  submit(q: FxQuote, txHash: Hex): Promise<void>;
}

export interface TextileOptions {
  apiBase: string;
  chainId: number;
  sellToken: Address; // USD₮
  sellDecimals?: number; // 6 on Celo, 18 for BSC testnet USDT
  buyToken: Address; // cNGN
  apiKey?: string;
  signTakerProof?: (msg: { taker: Address; chainId: bigint; nonce: Hex; issuedAt: bigint }) => Promise<Hex>;
  fetchImpl?: typeof fetch;
}

export const TAKER_CONTROL_TYPES = {
  TakerControl: [
    { name: "taker", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
  ],
} as const;

export function takerControlDomain(chainId: number) {
  return { name: "Textile Taker Control", version: "1", chainId } as const;
}

/** Convert a token amount to 6-decimal USD units, rounding up (we never under-count spend). */
export function toUsd6(amount: bigint, decimals: number): bigint {
  if (decimals === 6) return amount;
  if (decimals < 6) return amount * 10n ** BigInt(6 - decimals);
  const div = 10n ** BigInt(decimals - 6);
  return (amount + div - 1n) / div;
}

export class TextileClient implements FxProvider {
  constructor(private readonly o: TextileOptions) {}

  private get dec() {
    return this.o.sellDecimals ?? 6;
  }

  private get f() {
    return this.o.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
    if (this.o.apiKey) h.Authorization = `Bearer ${this.o.apiKey}`;
    return h;
  }

  async previewExactOut(buyAmount: bigint): Promise<bigint | null> {
    const res = await this.f(`${this.o.apiBase}/rfq/preview`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ chainId: this.o.chainId, sellToken: this.o.sellToken, buyToken: this.o.buyToken, buyAmount: buyAmount.toString() }),
    });
    const body = (await res.json()) as { data?: { status: string; takerPays?: string; sellAmount?: string } };
    if (!res.ok) throw new Error(`Textile preview HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    if (body.data?.status !== "preview") return null;
    return toUsd6(BigInt(body.data.takerPays ?? body.data.sellAmount ?? "0"), this.dec);
  }

  async requestExactOut(buyAmount: bigint, taker: Address): Promise<FxQuote | null> {
    const req: Record<string, unknown> = {
      chainId: this.o.chainId,
      sellToken: this.o.sellToken,
      buyToken: this.o.buyToken,
      buyAmount: buyAmount.toString(),
      taker,
    };
    if (!this.o.apiKey) {
      if (!this.o.signTakerProof) throw new Error("Keyless Textile quotes need a takerProof signer");
      const nonce = keccak256(toHex(`${taker}:${Date.now()}:${Math.random()}`));
      const issuedAt = BigInt(Date.now());
      const signature = await this.o.signTakerProof({ taker, chainId: BigInt(this.o.chainId), nonce, issuedAt });
      req.takerProof = { nonce, issuedAt: Number(issuedAt), signature };
    }
    // The firm request can block up to ~70 s on a cold corridor (docs): allow 75 s.
    const res = await this.f(`${this.o.apiBase}/rfq/request`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(75_000),
    });
    const body = (await res.json()) as { data?: RfqData; error?: unknown };
    if (!res.ok) throw new Error(`Textile request HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    const d = body.data;
    if (!d || d.status !== "quoted" || !d.quote || !d.transactions) return null;
    const q = d.quote;
    if (BigInt(q.buyAmount) < buyAmount) throw new Error(`Textile quoted ${q.buyAmount} < requested ${buyAmount}`);
    if (q.taker.toLowerCase() !== taker.toLowerCase()) throw new Error("Textile quote bound to a different taker");
    return {
      rfqId: d.rfqId,
      claimToken: d.claimToken,
      buyAmount: BigInt(q.buyAmount),
      takerPays: toUsd6(BigInt(q.takerPays), this.dec),
      takerPaysRaw: BigInt(q.takerPays),
      feeAmount: BigInt(q.feeAmount),
      expiresAt: Date.parse(q.expiresAt),
      reactor: q.reactor as Address,
      swap: { to: d.transactions.swap.to as Address, data: d.transactions.swap.data as Hex },
    };
  }

  async submit(q: FxQuote, txHash: Hex): Promise<void> {
    // A courtesy: settlement is reconciled on chain either way, so failures are ignored.
    try {
      await this.f(`${this.o.apiBase}/rfq/${q.rfqId}/submit`, {
        method: "POST",
        headers: this.headers(this.o.apiKey ? {} : { "X-Rfq-Claim": q.claimToken }),
        body: JSON.stringify({ txHash }),
      });
    } catch {
      /* ignored on purpose */
    }
  }
}

interface RfqData {
  rfqId: string;
  claimToken: string;
  status: string;
  quote?: {
    sellAmount: string; buyAmount: string; feeAmount: string; takerPays: string;
    expiresAt: string; reactor: string; taker: string;
  };
  transactions?: { approval: { to: string; data: string }; swap: { to: string; data: string } };
}

/** Dry-run FX: a fixed NGN/USD rate plus Textile's 2 bps fee. Clearly labelled as simulated. */
export class FixedRateFx implements FxProvider {
  constructor(
    private readonly ngnPerUsd: number,
    private readonly reactor: Address,
    private readonly now: () => number = Date.now,
  ) {}

  private cost(buyAmount: bigint): bigint {
    const usd = (buyAmount * 1_000_000n) / BigInt(Math.round(this.ngnPerUsd * 1_000_000));
    return usd + (usd * 2n) / 10_000n + 1n;
  }

  async previewExactOut(buyAmount: bigint) {
    return this.cost(buyAmount);
  }

  async requestExactOut(buyAmount: bigint) {
    const takerPays = this.cost(buyAmount);
    return {
      rfqId: `rfq_dry_${this.now()}`,
      claimToken: "rfqc_dry",
      buyAmount,
      takerPays,
      takerPaysRaw: takerPays,
      feeAmount: (takerPays * 2n) / 10_000n,
      expiresAt: this.now() + 60_000,
      reactor: this.reactor,
      // Placeholder calldata for the simulated swap; never broadcast (dry run only).
      swap: { to: this.reactor, data: "0x00000000" as Hex },
    };
  }

  async submit() {}
}

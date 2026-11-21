// Pinhold's agent wallet. Every transaction goes through `send`, which:
//   1. appends the ERC-8021 attribution tag to the calldata,
//   2. signs locally and records the hash BEFORE broadcasting (so a crash never pays twice),
//   3. in DRY_RUN, logs the fully built transaction and broadcasts nothing.

import {
  type Account,
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  toHex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tag } from "../attribution.js";
import type { Address } from "../core/types.js";
import type { ChainProfile } from "../networks.js";

export interface SendRequest {
  to: Address;
  data: Hex;
  label: string; // human description for logs and dry-run output
}

export interface SentTx {
  hash: Hex;
  dryRun: boolean;
}

export interface ChainWallet {
  readonly address: Address;
  readonly chainId: number;
  readonly dryRun: boolean;
  send(req: SendRequest, onSigned?: (hash: Hex, raw: Hex | null) => void): Promise<SentTx>;
  rebroadcast(raw: Hex): Promise<void>;
  waitFor(hash: Hex): Promise<"success" | "reverted">;
  erc20Balance(token: Address, owner?: Address): Promise<bigint>;
  erc20Allowance(token: Address, spender: Address): Promise<bigint>;
  signTypedData(args: Parameters<Account["signTypedData"] & {}>[0]): Promise<Hex>;
  readonly publicClient: PublicClient;
  /** Dry run only: every transaction that would have been sent, exactly as built. */
  readonly built: Array<{ label: string; to: Address; data: Hex; hash: Hex }>;
}

export function viemChain(p: ChainProfile): Chain {
  return defineChain({
    id: p.chainId,
    name: p.name,
    nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [p.rpcUrl] } },
  });
}

/** Deterministic fake hash for dry runs, so receipts and the verify script can show them. */
export function dryRunHash(label: string, data: Hex): Hex {
  return keccak256(toHex(`pinhold-dry-run:${label}:${data}`));
}

export function makeWallet(opts: {
  profile: ChainProfile;
  privateKey?: Hex;
  attributionCode: string;
  dryRun: boolean;
  log: (line: string) => void;
  dryRunAddress?: Address;
}): ChainWallet {
  const chain = viemChain(opts.profile);
  const publicClient = createPublicClient({ chain, transport: http(opts.profile.rpcUrl) }) as PublicClient;
  const account = opts.privateKey ? privateKeyToAccount(opts.privateKey) : null;
  const walletClient: WalletClient | null = account
    ? createWalletClient({ account, chain, transport: http(opts.profile.rpcUrl) })
    : null;
  const address = (account?.address ?? opts.dryRunAddress ?? "0x00000000000000000000000000000000000d1a2d") as Address;

  const built: ChainWallet["built"] = [];
  return {
    built,
    address,
    chainId: opts.profile.chainId,
    dryRun: opts.dryRun,
    publicClient,

    async send(req, onSigned) {
      const data = tag(req.data, opts.attributionCode);
      if (opts.dryRun) {
        const hash = dryRunHash(req.label, data);
        built.push({ label: req.label, to: req.to, data, hash });
        opts.log(`[dry-run] ${opts.profile.name} tx ${req.label}: to=${req.to} data=${data.slice(0, 10)}…(${(data.length - 2) / 2} bytes, tagged ${opts.attributionCode}) hash=${hash}`);
        onSigned?.(hash, null);
        return { hash, dryRun: true };
      }
      if (!walletClient || !account) throw new Error("No AGENT_PRIVATE_KEY: cannot send transactions");
      const prepared = await walletClient.prepareTransactionRequest({ account, chain, to: req.to, data, value: 0n });
      const raw = await walletClient.signTransaction(prepared as never);
      const hash = keccak256(raw);
      onSigned?.(hash, raw); // persisted by the caller before the broadcast
      await publicClient.sendRawTransaction({ serializedTransaction: raw });
      opts.log(`${opts.profile.name} tx ${req.label}: ${hash}`);
      return { hash, dryRun: false };
    },

    async rebroadcast(raw) {
      if (opts.dryRun) return;
      try {
        await publicClient.sendRawTransaction({ serializedTransaction: raw });
      } catch (e) {
        // "already known" / "nonce too low" mean it is already in the mempool or mined.
        const msg = String((e as Error).message ?? e);
        if (!/known|nonce too low|already/i.test(msg)) throw e;
      }
    },

    async waitFor(hash) {
      if (opts.dryRun) return "success";
      const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      return r.status;
    },

    async erc20Balance(token, owner) {
      if (opts.dryRun && !account) return 10n ** 12n;
      return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner ?? address] });
    },

    async erc20Allowance(token, spender) {
      if (opts.dryRun && !account) return 0n;
      return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [address, spender] });
    },

    async signTypedData(args) {
      if (!account) {
        if (opts.dryRun) return `0x${"00".repeat(65)}` as Hex;
        throw new Error("No AGENT_PRIVATE_KEY");
      }
      return account.signTypedData(args as never);
    },
  };
}

export function transferData(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
}

export function approveData(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
}

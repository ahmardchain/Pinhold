// Configuration from the environment (.env). Secrets are read here and nowhere else,
// and are never logged: `describeConfig` prints only non-secret fields.

import "dotenv/config";
import { z } from "zod";
import { NETWORKS, type NetworkProfile } from "./networks.js";

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const usd = (def: string) => z.string().default(def).transform((v) => BigInt(Math.round(Number(v) * 1e6)));

const schema = z.object({
  PINHOLD_NETWORK: z.enum(["mainnet", "testnet"]).default("testnet"),
  // DRY_RUN=true: every check runs, every transaction is built and logged, nothing is sent,
  // and payments come from the dev endpoint instead of x402.
  DRY_RUN: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  // Mainnet needs an explicit second switch, so a stray env file cannot move real money.
  ALLOW_MAINNET: z.enum(["yes", "no"]).default("no"),

  AGENT_PRIVATE_KEY: hexKey.optional(), // Pinhold's wallet: x402 payTo, Textile taker, payouts, refunds
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_LOG_CHAT_ID: z.string().optional(), // private chat used for post existence checks
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional(), // where Pinhold alerts its operator
  X402_API_KEY: z.string().optional(),
  TEXTILE_API_KEY: z.string().optional(), // optional; keyless quotes sign a takerProof instead

  ATTRIBUTION_CODE: z.string().regex(/^[a-z0-9_]{1,32}$/).optional(), // issued at Loops enrollment
  GITHUB_REPO: z.string().default("ahmardchain/pinhold"), // the tag is derived from this slug

  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8787"),
  PORT: z.coerce.number().default(8787),
  DATABASE_PATH: z.string().default("./data/pinhold.db"),

  DAILY_CAP_USDT: usd("25"), // all outflows per UTC day
  MAX_BOOKING_USDT: usd("10"),
  MIN_BOOKING_USDT: usd("2"),
  SURPLUS_MIN_RETURN_USDT: usd("0.10"),
  FX_BUFFER_BPS: z.coerce.number().int().min(0).max(1000).default(200),
  MAX_OPEN_ESCROWS_PER_HUMAN: z.coerce.number().int().min(1).default(1),
  POST_DEADLINE_HOURS: z.coerce.number().default(12),
  CHECK_INTERVAL_MINUTES: z.coerce.number().default(10),
  // Dry run only: fixed NGN per USD used instead of a live Textile preview.
  DRY_RUN_NGN_PER_USD: z.coerce.number().default(1500),
  SELF_OWNER_ADDRESS: address.optional(),
});

export type Config = z.infer<typeof schema> & { net: NetworkProfile };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Zod messages name the variable and the rule, never the value.
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  if (c.PINHOLD_NETWORK === "mainnet" && c.ALLOW_MAINNET !== "yes") {
    throw new Error("PINHOLD_NETWORK=mainnet requires ALLOW_MAINNET=yes");
  }
  if (!c.DRY_RUN && !c.AGENT_PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY is required unless DRY_RUN=true");
  if (!c.DRY_RUN && !c.X402_API_KEY) throw new Error("X402_API_KEY is required unless DRY_RUN=true");
  if (c.PINHOLD_NETWORK === "mainnet" && !c.ATTRIBUTION_CODE) {
    throw new Error("ATTRIBUTION_CODE is required on mainnet: untagged transactions can never be credited");
  }
  return { ...c, net: NETWORKS[c.PINHOLD_NETWORK] };
}

export function describeConfig(c: Config): string {
  return [
    `network=${c.net.name}`,
    `dryRun=${c.DRY_RUN}`,
    `pay=${c.net.pay.name} ${c.net.pay.stable.symbol}`,
    `fx=${c.net.fx.name}`,
    `dailyCap=${Number(c.DAILY_CAP_USDT) / 1e6}`,
    `maxBooking=${Number(c.MAX_BOOKING_USDT) / 1e6}`,
    `attribution=${c.ATTRIBUTION_CODE ?? "none"}`,
    `telegram=${c.TELEGRAM_BOT_TOKEN ? "on" : "off"}`,
  ].join(" ");
}

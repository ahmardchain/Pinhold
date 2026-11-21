// Pinhold sponsor agent: what an advertiser runs (or what any other agent copies) to book a post.
//
// It signs every request with its Self Agent ID key and pays the escrow over x402 from the
// same key's wallet. Pinhold checks the Self proof before quoting and again before taking
// payment; an agent without one gets a 401.
//
//   npm run sponsor -- register                  # one-time Self Agent ID registration (passport scan)
//   npm run sponsor -- whoami
//   npm run sponsor -- channels
//   npm run sponsor -- book @channel "Ad text"   # quote, then pay over x402
//   npm run sponsor -- status <bookingId>
//
// Env (.env.sponsor or the shell):
//   PINHOLD_URL=https://…            Pinhold API base
//   SPONSOR_NETWORK=testnet|mainnet  Self + x402 network (default testnet)
//   SPONSOR_KEY_FILE=.self/sponsor.key  where `register` stores the agent key (chmod 600)
//   SPONSOR_MAX_USD=10                refuse to pay more than this per booking

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requestRegistration, SelfAgent } from "@selfxyz/agent-sdk";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import dotenv from "dotenv";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS } from "../src/networks.js";

dotenv.config({ path: process.env.SPONSOR_ENV ?? ".env.sponsor" });

const network = (process.env.SPONSOR_NETWORK ?? "testnet") as "mainnet" | "testnet";
const net = NETWORKS[network];
const base = (process.env.PINHOLD_URL ?? "http://localhost:8787").replace(/\/$/, "");
const keyFile = process.env.SPONSOR_KEY_FILE ?? ".self/sponsor.key";
const maxUsd = Number(process.env.SPONSOR_MAX_USD ?? "10");

function loadKey(): Hex {
  if (!existsSync(keyFile)) throw new Error(`No agent key at ${keyFile}. Run: npm run sponsor -- register`);
  return readFileSync(keyFile, "utf8").trim() as Hex;
}

/** fetch that signs each attempt with the Self agent key (x402 retries get a fresh signature). */
function selfFetch(agent: SelfAgent): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    if (body !== undefined && body.length && !headers["content-type"]) headers["content-type"] = "application/json";
    return agent.fetch(req.url, { method: req.method, headers, body: body?.length ? body : undefined });
  };
}

async function register() {
  if (existsSync(keyFile)) throw new Error(`${keyFile} already exists; refusing to overwrite an agent key`);
  const session = await requestRegistration({ mode: "wallet-free", network, disclosures: { minimumAge: 18 } });
  console.log(`Scan with the Self app (${network === "testnet" ? "MOCK passport on testnet" : "your real passport"}):`);
  console.log(`  ${session.deepLink}\n  QR: ${session.scanUrl}`);
  const { agentId, agentAddress } = await session.waitForCompletion();
  const key = await session.exportKey();
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  console.log(`Registered Self agent #${agentId} at ${agentAddress}. Key saved to ${keyFile} (not printed).`);
  console.log(`Fund ${agentAddress} with ${net.pay.stable.symbol} on ${net.pay.name} from your own wallet or exchange; it pays the escrow.`);
}

async function whoami() {
  const agent = new SelfAgent({ privateKey: loadKey(), network });
  const info = await agent.getInfo();
  console.log(JSON.stringify({ address: agent.address, agentId: info.agentId?.toString(), verified: info.isVerified, proofExpiresAt: info.proofExpiresAt?.toString() }, null, 2));
}

async function book(channel: string, text: string) {
  const key = loadKey();
  const agent = new SelfAgent({ privateKey: key, network });
  const signed = selfFetch(agent);

  // 1. Quote (Self-signed). An unverified agent stops here with a 401.
  const q = await signed(`${base}/api/bookings`, { method: "POST", body: JSON.stringify({ channel, text }) });
  const quote = (await q.json()) as Record<string, any>;
  if (q.status !== 201) {
    console.error(`Refused (${q.status}): ${quote.error}: ${quote.message}`);
    process.exit(1);
  }
  const usd = Number(quote.price.amount) / 1e6;
  console.log(`Quote ${quote.id}: ${quote.price.display} ${quote.price.asset} for ₦${quote.priceNgn}, ${quote.holdHours} h on ${quote.channel}`);
  if (usd > maxUsd) throw new Error(`Quote ${usd} exceeds SPONSOR_MAX_USD=${maxUsd}; not paying`);

  // 2. Pay over x402 from the agent's own wallet, capped at exactly the quoted amount.
  const account = privateKeyToAccount(key);
  const client = new x402Client();
  client.setSpendControls({
    allowedAssets: [{ network: net.pay.x402Network, asset: getAddress(net.pay.stable.address), maxAmountPerPayment: quote.price.amount }],
    maxAmountPerPayment: `$${maxUsd}`,
  });
  client.register("eip155:*", new ExactEvmScheme(account, { rpcUrl: net.pay.rpcUrl }));
  const pay = wrapFetchWithPayment(signed, client);
  const r = await pay(quote.payUrl, { method: "POST" });
  const body = await r.json().catch(() => ({}));
  const header = r.headers.get("payment-response") ?? r.headers.get("x-payment-response");
  const settlement = header ? decodePaymentResponseHeader(header) : null;
  if (!r.ok) {
    console.error(`Payment failed (${r.status}): ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log(`Paid. Settlement tx: ${settlement?.transaction ?? (body as any).tx ?? "(see receipt)"}`);
  console.log(`Receipt: ${quote.receiptUrl}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "register") return register();
  if (cmd === "whoami") return whoami();
  if (cmd === "channels") return console.log(JSON.stringify(await (await fetch(`${base}/api/channels`)).json(), null, 2));
  if (cmd === "status") return console.log(JSON.stringify(await (await fetch(`${base}/api/bookings/${rest[0]}`)).json(), null, 2));
  if (cmd === "book" && rest.length >= 2) return book(rest[0], rest.slice(1).join(" "));
  console.log("Usage: npm run sponsor -- register | whoami | channels | book @channel \"ad text\" | status <bookingId>");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

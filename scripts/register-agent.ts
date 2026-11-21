// Pinhold's own identities. Nothing is sent unless you pass --send (and, on mainnet,
// PINHOLD_NETWORK=mainnet ALLOW_MAINNET=yes in .env).
//
//   npm run register:agent -- self            Self Agent ID (wallet-free). The Self app scan
//                                             creates the agent key; it is saved to
//                                             .self/pinhold-agent.key (chmod 600, never printed).
//                                             Use it as AGENT_PRIVATE_KEY: then Pinhold's payTo,
//                                             Textile taker and payout wallet is the Self agent.
//   npm run register:agent -- erc8004 [--send]
//                                             register(agentURI) on the ERC-8004 Identity Registry
//                                             from AGENT_PRIVATE_KEY, with the attribution tag.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { requestRegistration } from "@selfxyz/agent-sdk";
import { decodeEventLog, encodeFunctionData, type Hex, parseAbi } from "viem";
import { resolveAttributionCode } from "../src/attribution.js";
import { makeWallet } from "../src/chain/wallet.js";
import { loadConfig } from "../src/config.js";

const cmd = process.argv[2];
const send = process.argv.includes("--send");
const env = { ...process.env, ...(send ? { DRY_RUN: "false", X402_API_KEY: process.env.X402_API_KEY ?? "unused" } : { DRY_RUN: "true" }) };
const cfg = loadConfig(env as NodeJS.ProcessEnv);
const ABI = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

if (cmd === "self") {
  const out = ".self/pinhold-agent.key";
  if (existsSync(out)) throw new Error(`${out} exists; refusing to overwrite`);
  const s = await requestRegistration({ mode: "wallet-free", network: cfg.net.self.network });
  console.log(`Network: ${cfg.net.self.network} (${cfg.net.self.network === "testnet" ? "mock passport" : "real passport"})`);
  console.log(`Open in the Self app: ${s.deepLink}\nQR: ${s.scanUrl}`);
  const { agentId, agentAddress } = await s.waitForCompletion();
  const key = await s.exportKey();
  mkdirSync(".self", { recursive: true });
  writeFileSync(out, `${key}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`Self Agent ID #${agentId}, address ${agentAddress}. Key saved to ${out}.`);
  console.log(`Judges check: https://agent-api.self.xyz/api/agent/info/${cfg.net.self.chainId}/${agentId}`);
} else if (cmd === "erc8004") {
  const code = resolveAttributionCode(cfg.ATTRIBUTION_CODE, cfg.GITHUB_REPO, cfg.net.name);
  const w = makeWallet({ profile: cfg.net.pay, privateKey: cfg.AGENT_PRIVATE_KEY as Hex | undefined, attributionCode: code, dryRun: !send, log: console.log });
  const uri = `${cfg.PUBLIC_BASE_URL}/agent.json`;
  console.log(`${send ? "Sending" : "Dry run"}: register("${uri}") on ${cfg.net.pay.name} ${cfg.net.erc8004IdentityRegistry} from ${w.address}`);
  const sent = await w.send({ to: cfg.net.erc8004IdentityRegistry, data: encodeFunctionData({ abi: ABI, functionName: "register", args: [uri] }), label: "ERC-8004 register" });
  if (sent.dryRun) process.exit(0);
  const rcpt = await w.publicClient.waitForTransactionReceipt({ hash: sent.hash });
  for (const l of rcpt.logs) {
    try {
      const ev = decodeEventLog({ abi: ABI, data: l.data, topics: l.topics });
      if (ev.eventName === "Registered") console.log(`ERC-8004 agentId ${ev.args.agentId} (set ERC8004_AGENT_ID=${ev.args.agentId}); tx ${cfg.net.pay.explorerTx(sent.hash)}`);
    } catch { /* other log */ }
  }
} else {
  console.log("Usage: npm run register:agent -- self | erc8004 [--send]");
}

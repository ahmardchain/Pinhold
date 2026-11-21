// npm run preflight [-- mainnet]: read-only checks of every outside dependency.
// Sends no transaction and needs no key: token contracts, Self registry, Textile preview,
// x402 facilitator, ERC-8004 registry.

import { createPublicClient, erc20Abi, http } from "viem";
import { SelfIdentity } from "../src/chain/self.js";
import { TextileClient } from "../src/chain/textile.js";
import { NETWORKS, type NetworkName } from "../src/networks.js";

const name = (process.argv[2] ?? "testnet") as NetworkName;
const n = NETWORKS[name];
let bad = 0;
const line = (ok: boolean, what: string, detail: unknown) => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${typeof detail === "string" ? detail : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
};
const guard = async (what: string, f: () => Promise<[boolean, unknown]>) => {
  try { const [ok, d] = await f(); line(ok, what, d); } catch (e) { line(false, what, (e as Error).message.slice(0, 200)); }
};

const pay = createPublicClient({ transport: http(n.pay.rpcUrl) });
const fxc = createPublicClient({ transport: http(n.fx.rpcUrl) });
for (const [c, label, addr] of [[pay, `${n.pay.name} ${n.pay.stable.symbol}`, n.pay.stable.address], [fxc, `${n.fx.name} ${n.fx.stable.symbol}`, n.fx.stable.address], [fxc, `${n.fx.name} cNGN`, n.fx.cngn.address]] as const) {
  await guard(`token ${label} ${addr}`, async () => {
    const [sym, dec] = await Promise.all([c.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }), c.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" })]);
    const want = addr === n.fx.stable.address && n.fx.stable.address !== n.pay.stable.address ? n.fx.stable.decimals : 6;
    return [dec === want, `${sym}, ${dec} decimals`];
  });
}
await guard(`ERC-8004 identity registry ${n.erc8004IdentityRegistry}`, async () => {
  const code = await pay.getCode({ address: n.erc8004IdentityRegistry });
  return [!!code && code.length > 2, `${((code?.length ?? 2) - 2) / 2} bytes of code`];
});
const id = new SelfIdentity({ network: n.self.network, registry: n.self.registry, rpcUrl: n.pay.rpcUrl });
await guard(`Self registry ${n.self.registry} (agent #5)`, async () => {
  const p = await id.ownerProof("5");
  return [p !== null, p ?? "no agent #5"];
});
await guard("Self verifier turns away an unsigned request", async () => {
  const r = await id.verifySponsor({ signature: "", timestamp: "", method: "POST", url: "/api/bookings", body: "{}" });
  return [!r.valid, r.error ?? "valid?!"];
});
const tx = new TextileClient({ apiBase: n.fx.textileApi, chainId: n.fx.chainId, sellToken: n.fx.stable.address, sellDecimals: n.fx.stable.decimals, buyToken: n.fx.cngn.address });
const ngn = name === "mainnet" ? 5000 : 300; // the testnet corridor is a few hundred naira deep
await guard(`Textile preview on ${n.fx.name}: ${n.fx.stable.symbol} for exactly ₦${ngn} cNGN`, async () => {
  const v = await tx.previewExactOut(BigInt(ngn) * 1_000_000n);
  return [v !== null, v === null ? "no_quote" : `${Number(v) / 1e6} ${n.fx.stable.symbol} (≈ ₦${(ngn / (Number(v) / 1e6)).toFixed(0)}/$)`];
});
await guard(`x402 facilitator ${n.pay.facilitatorUrl}`, async () => {
  const s = (await (await fetch(`${n.pay.facilitatorUrl}/supported`)).json()) as { kinds?: Array<{ network: string; scheme: string }> };
  const hit = s.kinds?.find((k) => k.network === n.pay.x402Network && k.scheme === "exact");
  return [!!hit, hit ? `exact on ${hit.network}` : s];
});
console.log(bad ? `\n${bad} check(s) failed` : "\nAll preflight checks passed.");
process.exit(bad ? 1 : 0);

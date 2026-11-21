// npm run check:turnaway [-- <baseUrl>]: a brand-new, unregistered Self agent key signs a real
// booking request. Pinhold must answer 401 before quoting or asking for payment.
import { SelfAgent } from "@selfxyz/agent-sdk";
import { generatePrivateKey } from "viem/accounts";

const base = process.argv[2] ?? process.env.PINHOLD_URL ?? "http://localhost:8787";
const network = (process.env.SPONSOR_NETWORK ?? "testnet") as "mainnet" | "testnet";
const agent = new SelfAgent({ privateKey: generatePrivateKey(), network });
const res = await agent.fetch(`${base}/api/bookings`, { method: "POST", body: JSON.stringify({ channel: "@any", text: "Buy now" }) });
const body = await res.json();
console.log(res.status, JSON.stringify(body));
process.exit(res.status === 401 ? 0 : 1);

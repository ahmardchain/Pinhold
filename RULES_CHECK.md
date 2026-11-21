# Rules check: Pinhold for "Agents Open for Business"

Checked on 20–21 Nov 2026 against these live sources:

- Rules, tracks, FAQ: https://www.loops.house/agents-open-for-business
- Announcement: https://x.com/CeloDevs/status/2123778369590645006 (posted Fri 20 Nov 2026, 13:59 UTC)
- Textile FX docs: https://fx-docs.textilecredit.com (RFQ v2, authentication, fees, testnet)
- Self Agent ID docs: https://docs.self.xyz/docs/agent-id/overview/ (quickstart, SDK, registration modes, contracts)
- x402 on Celo: https://x402.celo.org/skill.md
- Attribution tags (ERC-8021 on Celo): https://github.com/celo-org/attribution-tags
- ERC-8004 on Celo: https://docs.celo.org/build-on-celo/build-with-ai/8004

**Targets:** Track 1, Stablecoin Corridors (Textile FX), and Track 3, Self Agent ID: Verified Agent Payments. Altana is dropped. The best case is $1,000 + $700 = $1,700.

Where the live rules and our plan disagree, the rules win. Each disagreement is marked **DIFFERS**.

## 1. General rules (every track)

| Rule (live text, shortened) | How Pinhold meets it | Status |
|---|---|---|
| Celo mainnet only; testnet references in the repo are fine | Mainnet profile: all activity on Celo (42220). The testnet profile is for the dry run only. | Built |
| Every entry registers its agent on ERC-8004 | `npm run register:agent -- erc8004 --send` calls `register(agentURI)` on `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, from the agent wallet, with our tag. The agentURI is `/agent.json`, served by Pinhold. | Built. Needs your yes. |
| Self Agent ID recommended | Required for Track 3 (see section 3). | Built. Needs your yes. |
| Public GitHub repo at registration, still resolving at judging | `ahmardchain/Pinhold` exists. You make it public before enrolling and never rename it (the tag depends on the slug). | You act |
| Attribution tag in every transaction you want counted; x402 sellers register their PayTo | Every transaction Pinhold sends gets the tag in `src/chain/wallet.ts`. The tag is the issued code, checked against `codeFromRepo` at startup. Sponsor payments arrive over x402, which carries no tag yet, so you register Pinhold's PayTo address (the agent wallet) at sign-up. | Built. You register PayTo. |
| Code written during the hackathon, from 20 Nov | First commit 20 Nov 2026. | OK |
| A project can win in up to two tracks | Tracks 1 and 3. | OK |
| Sponsored gas is not a builder contribution | The x402 facilitator pays settlement gas, which is the standard x402 flow. Pinhold pays its own gas for swaps, payouts and refunds. We'll say this in the submission. | OK |

Dates (unchanged since the first check): build opened Fri 20 Nov 14:00 GMT. **Self livestream Tue 24 Nov 14:00 GMT** (Agent ID), plus AskBots review 1. Stablecoin livestream Tue 1 Dec. AskBots review 2 Fri 4 Dec. **Submissions close Mon 7 Dec 09:00 GMT.** Winners Fri 11 Dec.

## 2. Track 1: Stablecoin Corridors (Textile FX)

Judging is 25% each: quality of execution, a clear value proposition, initial traction with tagged onchain activity, and a named user with a real job done.

| Requirement (live) | How Pinhold meets it | Where |
|---|---|---|
| At least one tagged Textile FX conversion on Celo mainnet in a listed corridor, used in the product flow | On every release: an exact-output RFQ (`buyAmount` = the owner's naira price) for USD₮ → cNGN, then `transactions.swap` broadcast with our tag appended | `src/executor.ts` release step 2, `src/chain/textile.ts` |
| Payments in a local stablecoin reach a recipient outside the team | A tagged cNGN `transfer` to the channel owner's payout wallet. The owner is someone you book ads with, not on the team. | `src/executor.ts` release step 3 |
| ERC-8004 identity | Section 1 | `scripts/register-agent.ts` |
| Arbitrage, self-trading, acting as a maker don't count | Taker only, one swap per real booking | — |

Live mainnet check on 21 Nov (`npm run preflight -- mainnet`): Textile previews **3.47 USD₮ for exactly ₦5,000 cNGN**, about ₦1,443/$. **DIFFERS (testnet):** Textile's RFQ sandbox runs only on BSC testnet (cNGN ↔ USDT, 18-decimal USDT). Base Sepolia's cNGN corridor isn't RFQ-enabled, and there's nothing on Celo Sepolia. The sandbox is also only about **₦449 deep**. So the testnet dry run splits across chains: escrow on Celo Sepolia, FX on BSC testnet, with bookings around ₦300.

## 3. Track 3: Self Agent ID, Verified Agent Payments

Prizes: 1st $700, 2nd $300. Judge: Self. Judging: quality of the integration 30%, innovation and value proposition 30%, a named user and a real job done 25%, real use 15%.

| Requirement (live text) | How Pinhold meets it | Where |
|---|---|---|
| "Agent registered with Self Agent ID on Celo mainnet; submit its agentId." Judges check `GET https://agent-api.self.xyz/api/agent/info/42220/<agentId>` | `npm run register:agent -- self` registers Pinhold's agent (wallet-free mode) and saves the generated key. That key becomes `AGENT_PRIVATE_KEY`, so Pinhold's payTo, Textile taker and payout wallet **is** the Self agent. | `scripts/register-agent.ts` |
| "At least one x402 payment through Celo's native facilitator (submit the hash)" | Every booking is paid over x402 (`api.x402.celo.org`) in USD₮ to Pinhold's payTo | `src/server.ts` pay route |
| "Identity changes what the product does: the service checks the human proof with SelfAgentVerifier or a registry read before it serves, pays or gives credit; link the file and line" | **Serves:** `SelfAgentVerifier` on every quote and payment request, so unverified agents get a 401 before a quote or a 402. **Limits:** a registry read of `getHumanNullifier`, giving one open escrow per human. **Pays:** a registry read (`ownerOf`, `hasHumanProof`, `isProofFresh`) before every payout. cNGN only goes to the wallet that owns the owner's Self agent NFT. | `src/chain/self.ts` `verifySponsor` / `ownerProof`; `src/server.ts` `requireSelfAgent`; `src/core/policy.ts` `admitBooking` / `payoutTarget` |
| "The demo shows a verified agent paying or getting paid and an unverified agent turned away; if you limit anything per person, two agents from the same person share one limit" | `npm run check:turnaway` shows a fresh unregistered key turned away with 401. This was checked against the real Celo Sepolia registry on 21 Nov. The dry run covers the same-human limit (agents A and A2 share a nullifier, and the second gets a 409). | `scripts/check-turnaway.ts`, `scripts/demo-dry-run.ts` |
| ERC-8004 identity | Section 1. Self's registry also implements ERC-8004, but we also register in the canonical registry, because the general rule names it. | — |
| "Public X post from a team member with what you built, a demo clip and the repo link, tagging @selfxyz and @Celo" | I draft it; **you post it.** | You act |
| Common mistakes listed by Self: testnet takes mock passports only; the default verifier allows one agent per person (use `.sybilLimit(0)`); verify the raw body | Testnet uses mock passports. We use `.sybilLimit(0)` and enforce our own per-human limit from the nullifier. Note that with `sybilLimit(0)` the SDK returns nullifier 0, so we read it from the registry ourselves. The raw body is kept by `express.json({ verify })`. | `src/chain/self.ts`, `src/server.ts` |

**Things this track adds that you need to know:**

1. **Every sponsor needs a Self Agent ID.** Each ad client registers an agent once with the Self app (a passport scan) and funds that agent's wallet with USD₮ from their own wallet or exchange. `npm run sponsor -- register` does the registration. The key stays on their machine (`.self/sponsor.key`, chmod 600). This is the biggest traction risk: non-crypto clients will need you on a call the first time. See decision 2.
2. **One open escrow per human** matches the rule ("two agents from the same person share one limit"), but it means one client can't book two channels at once. It's configurable (`MAX_OPEN_ESCROWS_PER_HUMAN`). I'd leave it at 1 for the demo and raise it for real use.
3. **x402 settlements carry no tag.** They're credited through the PayTo address you register at sign-up. Pinhold's own swap, payout and refund transactions are plain EOA transactions with our tag, so they're always attributable. The Altana-relay risk from the first check is gone.
4. **Competition:** you noted that AbaPay (a past 1st place) targets Tracks 1 and 3 with Nigerian bills. Our angle on Track 3 is two-sided identity, where Self decides both who may buy and who may be paid, plus the per-human limit. I'll make sure the demo shows both sides.

## 4. Addresses (all checked by RPC, 20–21 Nov)

| What | Mainnet (Celo) | Testnet |
|---|---|---|
| USD₮ | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` (6 dec) | x402 on Celo Sepolia: USDC `0x01C5…C44E`. FX on BSC testnet: USDT `0x3376…4dDd` (18 dec) |
| cNGN | `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` (6 dec) | BSC testnet `0x8a07…9dA8` (6 dec) |
| Textile reactor | `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3` | via API |
| Self Agent registry | `0xaC3DF9ABf80d0F5c020C06B04Cced27763355944` | `0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379` |
| ERC-8004 Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| x402 facilitator | `https://api.x402.celo.org` | `https://api.x402.sepolia.celo.org` |

Permit2 isn't used: USD₮ x402 runs on EIP-3009, and Textile approves the reactor directly. `npm run preflight -- mainnet` re-checks all of this, read-only.

## 5. Independent users (FAQ)

Counted: wallets outside the team that aren't funded by you. Your clients must fund their sponsor agents from their own wallets or an exchange, never from yours. Signers and authorisers count, so the x402 payer, the sponsor's agent, counts even though the facilitator pays gas.

## 6. Decisions I need from you

1. **Worker hosting.** One always-on Node process (API, bot, worker). Your machine or a small VPS. It needs a public HTTPS URL for agents to call.
2. **Sponsor onboarding.** Right now sponsors run the CLI. A small browser page that does the same thing (Self QR registration, a key kept in the browser, x402 pay) would make it far easier for non-crypto clients. It's about one day of work. I recommend it.
3. **Next.js on Vercel.** Receipts and stats are already served by the agent itself (`/r/:id`, `/stats`). I suggest dropping the separate Next.js site and spending the time on decision 2 instead.
4. **`MAX_OPEN_ESCROWS_PER_HUMAN`:** 1 for the demo, then 3 for real use?

# Rules check: Pinhold for "Agents Open for Business"

Checked on 20 Nov 2026 against these live sources:

- Rules, tracks, FAQ: https://www.loops.house/agents-open-for-business
- Announcement: https://x.com/CeloDevs/status/2123778369590645006 (posted Fri 20 Nov 2026, 13:59 UTC)
- Textile FX docs: https://fx-docs.textilecredit.com (RFQ v2, authentication, fees)
- Altana docs: https://docs.altana.network (`llms-full.txt`: sessions, grantSession, execute, revokeSession, networks)
- Attribution tags (ERC-8021 on Celo): https://github.com/celo-org/attribution-tags (README, BUILDERS.md)
- ERC-8004 on Celo: https://docs.celo.org/build-on-celo/build-with-ai/8004
- x402 on Celo: https://x402.celo.org/skill.md

Where the live rules and the build prompt disagree, the rules win. Each disagreement is marked **DIFFERS** below.

## 1. General rules (all tracks)

| Rule (live text, shortened) | How Pinhold meets it | Status |
|---|---|---|
| Celo mainnet only; testnet references in the repo are fine | All counted activity runs on Celo mainnet (chain 42220). Tests use mocks. | OK |
| Every entry registers its agent on ERC-8004 | The agent's Altana wallet calls `register` on the Celo mainnet Identity Registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`. The registration file names Pinhold, its job and its receipt URL. | Planned. Needs your yes (mainnet tx). |
| Self Agent ID recommended, not required | Optional. We can add it in the last week if your passport is on Self's supported list. | Optional |
| Public GitHub repo at registration, still resolving at judging | `ahmardchain/Pinhold` already exists. It must be public before you enroll, and it must not be renamed afterwards (see the tag section). | You act |
| Attribution tag in every transaction you want counted; x402 sellers also register their PayTo address | Every transaction the agent or the booking page sends gets the ERC-8021 suffix, added where the client is built. If we use x402, the agent wallet is registered as the PayTo address. | Planned, with one open risk (section 4) |
| Code written during the hackathon, from 20 Nov | The repo's first commit is 20 Nov 2026. Everything in it is new. | OK |
| A project can win in up to two tracks, one placement per track | We target Track 1 (Stablecoin Corridors) and Track 4 (Altana). | OK |
| Sponsored gas is not a builder contribution | Gas and relay fees are paid by the agent wallet itself, in USD₮, through Altana's relay. We will describe this in the submission. | OK |
| Paid calls on `buy` count as real use (optional) | Not planned. It would cost money and adds nothing to the escrow flow. | Skipped |

### Dates

| Item | Prompt | Live rules | Status |
|---|---|---|---|
| Build opens | 20 Nov | Fri 20 Nov, 14:00 GMT | OK |
| AskBots review 1 | 24 Nov | Tue 24 Nov. Reviews of "every registered project", posted as GitHub issues on the repo | OK |
| Altana livestream | not in prompt | Wed 25 Nov, 14:00 GMT | New info |
| Stablecoin Corridors livestream | not in prompt | Tue 1 Dec, 14:00 GMT | New info |
| AskBots review 2 | 4 Dec | Fri 4 Dec | OK |
| Submissions close | Mon 7 Dec, 10:00 Lagos (09:00 UTC) | Mon 7 Dec, 09:00 GMT. Registration also closes on Dec 7. | OK |
| Winners | 11 Dec | Fri 11 Dec | OK |
| Solo entries | allowed | The rules don't say anything against solo entries, and the FAQ speaks of "your team" generically. | OK, not stated outright |

The rules don't say you must register by 24 Nov to get review 1. They say registered projects get reviewed on 24 Nov. Registering before then is the safe reading.

## 2. Track 1: Stablecoin Corridors (Textile FX)

Prizes: 1st $1,000, 2nd $600, 3rd $400. These match the prompt. Judges are Textile and Celo Core Co.

Judging, 25% each: quality of execution, a clear value proposition, initial traction with tagged onchain activity, and a named user with a real job done.

| Requirement (live) | How Pinhold meets it | Status |
|---|---|---|
| At least one tagged Textile FX conversion on Celo mainnet in a listed corridor, used in the product flow | On every release, the agent swaps USD₮ to cNGN on Textile (Celo corridor cNGN ↔ USDT is live). It uses an exact-output quote (`buyAmount` = the naira price) and broadcasts `transactions.swap` with our tag appended. | Planned |
| Payments in a local stablecoin reach a recipient outside the team | After the swap, the agent sends the cNGN to the channel owner's own wallet in a tagged transfer. The owner is a real channel you already book ads with. | Planned. You recruit the owner. |
| ERC-8004 identity | See section 1. | Planned |
| Arbitrage, self-trading and acting as a Textile maker don't count | Pinhold only takes quotes, and only to pay out real bookings. | OK |

Textile facts, checked against the docs:

| Fact in the prompt | Docs | Status |
|---|---|---|
| Reactor `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3` | Listed on the rules page. Has contract code on Celo mainnet (checked by RPC). | OK |
| Mainnet minimum about $1 | "default $1 of notional." Also: a floor-sized exact-output buy can still return `no_valid_quote`, because the fee is charged on the sell side. | OK. Bookings stay ≥ $2. |
| Taker fee 2 bps | Celo (42220): 0.02% | OK |
| Use exact-output (`buyAmount`) | Supported. Send exactly one of `sellAmount` / `buyAmount`. | OK |
| Output goes only to the taker, so swap first, then transfer | The quote is bound to the taker wallet, and value lands in the taker's wallet. | OK |
| Permit2 is used | **DIFFERS.** Textile's flow approves `takerPays` of the sell token straight to the reactor. It doesn't use Permit2. Permit2 only matters for x402's Permit2 rail, which USD₮ doesn't use (USD₮ uses EIP-3009). I propose leaving Permit2 **off** the session allowlist. A smaller allowlist is a stronger demo. | Your call |
| Tagging the swap | FAQ: "request quotes with your wallet (no API key needed) and append your tag to `transactions.swap.data`… if you use a Textile API key, leave `includeAttribution` off so your tag is the only one." | OK |

Two Textile details we have to build around:

- **Quote TTL is about 60 s, and the approval must confirm before the swap.** The agent keeps a standing USD₮ allowance on the reactor so most swaps skip the approval. If `expiresAt` passes, it re-quotes.
- **Keyless quotes need a `takerProof` signed by the taker wallet.** Our taker is an Altana smart account, so it has to pass EIP-1271. Textile does support EIP-1271. Altana's docs add a catch: a session key's `isValidSignature` only returns the magic value when the *caller* is an approved checker (`approveSignatureChecker`). Textile's server is that caller, and we don't know its address. Fallbacks, in order: (a) have the wallet's admin key sign the proof (once per ~12 h), (b) get a free Textile partner API key, which skips the proof entirely. I'll test (a) with a mainnet `preview` and a firm `request`, which doesn't spend anything, once you say yes to connecting a wallet.

## 3. Track 4: Altana Agent Wallets

**DIFFERS (prize amounts).** Live prizes: 1st **$750 + 25,000 XP**, 2nd **$250 + 10,000 XP**. Product reviews earn 5,000 XP each, up to 10, one per team. The prompt's "$1K plus 35K XP" is the whole track pool. One project can take only one placement, so the most Pinhold can win here is $750 + 25,000 XP, plus 5,000 XP for a product review. XP is credited to the Altana wallet registered on the Keystore, not to the payout wallet. Judge: Altana.

Judging is the same 25% × 4 as Track 1.

| Requirement (live) | How Pinhold meets it | Status |
|---|---|---|
| The agent acts from a non-custodial Altana wallet | You create the wallet with `createWallet` on `CELO`. Your admin key stays in your `.env`. The agent only ever gets a session. | Planned. Needs your yes. |
| …under a session key a person grants | You grant the session (`grantSession`, registered on the Celo Keystore `0x83b30935f36d6ccf9B1ec3b5E47F2866b97cd27c`). | Planned |
| A spend cap | Per-token caps on USD₮ and cNGN. | Planned, see the note below |
| An allowlist of contracts it can call | `calls: [USD₮, cNGN, Textile reactor]`, narrowed by function signature where we can. | Planned |
| An expiry | For example 14 days, renewed for the judging window. | Planned |
| Enforced onchain and revocable in one transaction | `revokeSession` is one call. After it confirms, the next `execute` reverts at validation. | Planned (demo) |

**DIFFERS (cap shape).** The prompt asks for a "per-transaction and total spend cap." Altana's caps are **per token, per rolling period** (`{ limit, period: "minute" | "hour" | "day" | …, token }`). There's no native per-transaction cap and no lifetime cap. What I propose:

- USD₮: a cap of, say, 25 USD₮ per `day`. This covers refunds, swap input and relay fees. Altana charges relay fees against the cap, so the cap needs fee headroom.
- cNGN: a per-day cap sized to the day's expected payouts.
- The "total" is bounded by cap × days until expiry.
- The over-cap demo: a booking or forced payout that would push the day over the cap. The wallet rejects it with `ExceededSpendLimit`. One thing to know for the video: the docs show this as "intent reverted: ExceededSpendLimit" from the relay's simulation, so most likely nothing lands onchain. The rejection then shows as the relay/SDK error plus the session's onchain cap, not as a reverted transaction on Celoscan. I'll confirm which happens during the cap test. That still counts as "rejected by the wallet, not my code," because our code doesn't check the cap at all.

Also unconfirmed: whether Altana counts an `approve` toward the spend cap, or only `transfer`. The swap moves USD₮ by `approve` + the reactor's `transferFrom`. I'll confirm this on mainnet with a $1 test before the demo.

**Cost you'll need to fund:** Altana charges a Keystore registration fee in CELO. Its changelog quotes "about 9.2 CELO" for a registration, and twice on a wallet's first grant. Plan on roughly 20 CELO plus a few USD₮ for relay fees. I can quote the exact figure with `quoteGrantSession` before anything is sent.

## 4. Attribution tags (ERC-8021): the biggest open risk

What the docs say:

- The tag is a code appended to the calldata of every transaction. It's issued at enrollment. Untagged transactions can't be credited later. This matches the prompt.
- **New:** program codes are derived from your **GitHub `owner/repo`**: `codeFromRepo("ahmardchain/pinhold")` = `celo_` + the first 12 hex characters of the SHA-256 of the slug. The slug is lowercased, so `Pinhold` vs `pinhold` doesn't matter. **Don't rename, transfer or recreate the repo after enrolling**, or the tag credits nobody. The agent will assert `codeFromRepo(repo) === ATTRIBUTION_CODE` at startup and refuse to run if they differ.
- **x402 payments carry no tag yet.** The Celo facilitator doesn't write Schema 2 tags. The fix is to register our PayTo address at sign-up.

**Open risk: tags through the Altana wallet.** Altana wallets are smart accounts (Porto-based, EIP-7702). Their transactions are submitted by Altana's relay. We can put our suffix on each inner call's data, but the outer transaction is the relay's call. Celo's `verifyTx` decodes ERC-4337 `handleOps` bundles. Neither Celo's nor Altana's docs say whether Altana relay transactions get decoded. Textile's docs warn: "An inner swap tag alone doesn't guarantee attribution through a hosted wallet that hides that hook." If the indexer doesn't read Altana relay transactions, **every agent-side transaction (swap, payout, refund) could go uncredited**, even though the tag is onchain.

What I propose:

1. Ask in the hackathon Telegram (t.me/celoagenthackathons) and Altana's Telegram **this weekend**, before you enroll: "Are tagged calls executed through the Altana relay on Celo credited by the attribution indexer?" I'll draft the message.
2. Once you say yes to a test, send one $1 tagged transfer from the Altana wallet, then decode it with `verifyTx` / `verifyUserOps` and on Celoscan. Note this test would be a counted-looking transaction, so it should go **after** enrollment.
3. If the answer is no, the fallback keeps Track 1 safe. The sponsor's payment is a tagged EOA transaction from the booking page, and that's always attributable. The agent-side transactions still carry tags for when the indexer catches up. We'd describe the gap honestly in the submission.

## 5. Payment intake: x402 or a tagged transfer

The x402 facilitator API is `https://api.x402.celo.org` (`x402.celo.org` is the dashboard). USD₮ is enabled there on the EIP-3009 rail. cNGN is enabled on Permit2. cUSD isn't listed, which matches the prompt. The live list is USDC, USD₮ and USA₮, plus wARS, wBRL, wMXN, wCOP, wPEN, wCLP and cNGN.

My recommendation:

- **Main path: a tagged USD₮ transfer from the booking page.** The sponsor connects a wallet, and the page sends `USD₮.transfer(agentWallet, amount)` with our suffix. It's attributable today, and the watcher matches it by amount, sender and booking id.
- **Second door: x402 at `POST /api/bookings/:id/pay`**, for sponsors that are agents (an agent with its own ERC-8004 identity also counts as an independent user). It isn't tagged, so we register the PayTo address. This is a small add-on, built only if days 1–10 are on schedule.

## 6. Other facts from the prompt

| Fact | Check | Status |
|---|---|---|
| USD₮ `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | Celo RPC: `symbol()` = `USD₮`, `decimals()` = 6. Same address on the rules page and in the x402 table. | OK |
| cNGN `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` | Celo RPC: `symbol()` = `cNGN`, `decimals()` = 6. Same address on the rules page and in the x402 table. | OK |
| Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Has code on Celo mainnet. Not needed (see section 2). | OK |
| Textile reactor | Has code on Celo mainnet. | OK |
| ERC-8004 Identity Registry | Celo mainnet `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (has code). `0x8004A818…` is Celo Sepolia. | OK |
| Watch out for | USD₮ has an 18-decimal fee-currency adapter at `0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72` with the same name and symbol. The code hardcodes the real token and rejects anything else. | Noted |
| "Verify on Celoscan" | I checked all addresses by direct RPC (`eth_getCode`, `symbol`, `decimals`). Celoscan's page didn't render for a script, so please open the five links once in a browser yourself. | You check |
| MiniPay can't show cNGN | I couldn't confirm this either way. We'll tell owners to use Valora or another wallet that shows custom tokens. | Your info |

## 7. Independent users (from the FAQ)

- Counts: "A wallet outside your team and not funded by you or your main funder." New Celo users count. So does an agent wallet with its own ERC-8004 identity registered by another team.
- Doesn't count: liquidity pools, routers, Textile makers, exchange wallets. Arbitrage and self-trading score zero.
- So **don't send your clients the USD₮ they pay with.** If a client needs help getting USD₮, point them to an exchange or a ramp, not your wallet.
- The judges count signers and authorisers, not only gas payers.
- The submission should say who the users are and how you reached them.

## 8. Decisions I need from you before building

1. **Track 4 prize:** you're fine that the realistic maximum is $750 + 25K XP (plus 5K XP for a review), not $1K + 35K.
2. **Cap shape:** per-day rolling caps on USD₮ and cNGN in place of "per-transaction + total."
3. **Permit2:** off the allowlist.
4. **Attribution risk:** you're OK with me drafting the Telegram question, and with you asking it before enrolling.
5. **Payment intake:** a tagged transfer first, x402 as an add-on.
6. **Hosting the worker:** the post checker and the Telegram bot need an always-on process. Vercel Hobby cron runs once a day at most, so that doesn't work. Options: a free or cheap VPS, your own machine during the hackathon, or Fly.io/Render free tiers. The Next.js site and the database (Neon or Supabase free Postgres) stay free.
7. **CELO funding:** about 20 CELO for Altana registration, plus a small USD₮ float for refunds and fees.

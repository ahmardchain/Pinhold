# Pinhold

**An escrow agent for Telegram channel ads, paid in naira on Celo.**

Telegram channel ads run on trust, and it breaks both ways. Channel owners run ads and then chase payments for weeks. Sponsors pay up front for posts that get deleted an hour later. And Nigerian owners want naira, not dollars.

Pinhold holds the sponsor's money until the post has stayed up for the agreed time. Then it pays the channel owner in cNGN. If the post never goes up, or is deleted or edited during the hold window, the sponsor gets the money back automatically.

> Status (21 Nov 2026): built and checked on testnet and offline. It hasn't run on mainnet yet. Live numbers will appear here once real bookings exist; see [PROOF.md](PROOF.md).

## How it works

1. **A sponsor's agent asks for a booking.** Every request is signed with the agent's Self Agent ID key. Pinhold checks the proof of human first. An agent without a fresh Self proof gets a `401` and is never quoted.
2. **Pinhold quotes** the owner's naira price in USD₮, using a live Textile FX quote plus a 2% rate buffer. Each human can have one open escrow at a time, across all of their agents.
3. **The agent pays over x402** in USD₮ to Pinhold's wallet, through Celo's x402 facilitator.
4. **The owner posts** the exact text. Pinhold's bot is an admin of the channel with no permissions, so it sees the post and its edits.
5. **Pinhold checks** the post every 10 minutes during the hold window. It copies the post into a private log chat to prove it still exists, and cross-checks the public `t.me` page.
6. **Released:** Pinhold re-checks the owner's Self proof on chain, buys exactly the booked naira with an exact-output **Textile FX** swap (USD₮ → cNGN), and sends the cNGN to the owner's verified wallet. Leftover buffer goes back to the payer.
7. **Refunded:** if the post never appears, or is deleted or edited, the USD₮ goes back to the wallet that paid it, and only that wallet.

Every booking has a public receipt showing the post link, the check timeline and each transaction.

## Sponsor tech

- **Textile FX:** an RFQ exact-output swap from USD₮ to cNGN on Celo for every payout (`src/chain/textile.ts`).
- **Self Agent ID:** decides who gets served (sponsor agents, `SelfAgentVerifier`), who is limited (one open escrow per human, via the registry nullifier), and who gets paid (the owner's Self agent NFT must be owned by the payout wallet) (`src/chain/self.ts`, `src/core/policy.ts`).
- **x402:** sponsors pay through Celo's native facilitator (`src/server.ts`).
- **ERC-8004:** Pinhold's agent identity, registered from its own wallet (`scripts/register-agent.ts`, `/agent.json`).
- **ERC-8021:** every transaction Pinhold sends carries its attribution tag. The code is checked against the repo at startup (`src/attribution.ts`, `src/chain/wallet.ts`).

The deterministic state machine (`src/core/machine.ts`) is the only thing that decides release or refund. No AI moves money.

## Run it

```bash
npm ci
npm test              # 32 tests: state machine, policies, attribution
npm run demo:dry      # offline end-to-end dry run, 17 checks, no keys or network
npm run preflight     # read-only checks of every outside dependency (add "-- mainnet")
cp .env.example .env  # then see docs/TESTNET.md for the full testnet run
npm start
```

Sponsor side: `npm run sponsor -- register`, then `npm run sponsor -- book @channel "ad text"`. Owner side: see the Telegram bot's `/start`, or [docs/ONBOARDING.md](docs/ONBOARDING.md).

## Layout

```
src/core/       pure logic: types, state machine, policies (admission, payout/refund targets, daily cap, pricing)
src/chain/      wallet (tag, sign, record, broadcast), Textile client, Self identity
src/telegram/   bot (owner onboarding, post updates) and post existence probe
src/            config, networks, db, executor, engine, worker, server, main
src/web/        receipt and stats pages
sponsor/        sponsor agent CLI (Self signing + x402 paying)
scripts/        demo-dry-run, preflight, check-turnaway, verify, register-agent
```

## Limitations

- **Deletion is seen within about 10–20 minutes, not instantly.** Telegram's Bot API has no deletion event. Pinhold needs two missed checks in a row before refunding, so a short Telegram outage doesn't trigger one.
- Channels that restrict saving content block the copy check. For those, Pinhold falls back to the public `t.me` page, which only works for public channels.
- Pinhold doesn't enforce pinning, position in the feed or view counts. It only checks that the exact text stays up.
- The sponsor price includes a 2% buffer against the naira rate moving between booking and release. A bigger move is covered from Pinhold's own USD₮ float. If the float can't cover it, the release keeps retrying for 6 hours and then refunds the sponsor.
- Every sponsor needs a Self Agent ID (a passport scan in the Self app) and their own USD₮.
- x402 settlements carry no ERC-8021 tag yet (a facilitator limitation). They're attributed through Pinhold's registered PayTo address.
- One process and one SQLite file. Fine for the hackathon's volume, not built for scale.

Built by [@Ahmardchain](https://x.com/Ahmardchain) (ahmardchain@gmail.com). MIT licence.

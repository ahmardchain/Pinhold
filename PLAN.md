# Pinhold: architecture and plan (proposal)

Status: a proposal, waiting for your go. Nothing below has been built, deployed or sent.

## Architecture

```
 Sponsor (Telegram or web)          Channel owner (Telegram)
        │ book + pay USD₮                 │ adds bot (admin, no rights), posts ad
        ▼                                 ▼
 ┌──────────────┐  tagged USD₮      ┌──────────────────────────────┐
 │ apps/web     │  transfer  ──────▶│ Agent's Altana wallet (Celo) │
 │ Next.js on   │                   │ session key: caps, allowlist,│
 │ Vercel       │                   │ expiry; revocable            │
 │ booking form │                   └──────────────▲───────────────┘
 │ receipts     │                                  │ execute(session, calls)
 │ stats        │◀── reads ──┐                     │ (tagged calldata)
 └──────────────┘            │      ┌──────────────┴───────────────┐
                        ┌────┴────┐ │ apps/agent (always-on Node)  │
                        │Postgres │◀┤  payment watcher (USD₮ logs) │
                        │bookings,│ │  post checker (bot + t.me)   │
                        │checks,  │ │  state machine (pure)        │
                        │tx hashes│ │  executor: Textile + Altana  │
                        └─────────┘ │  Telegram bot (grammY)       │
                                    └──────────────────────────────┘
```

### Repo layout (pnpm workspace, TypeScript)

- `packages/core`: types, config loader (zod over `.env`; secrets are never logged), the attribution module (`toDataSuffix`, plus the startup check `codeFromRepo` = the code you were issued), and the **state machine**. The state machine is a pure function `decide(booking, event, now) → { next, actions[] }`. It does no I/O, so it's easy to test.
- `packages/chain`: viem public client for Celo, a USD₮ `Transfer` log watcher, a **Textile client** (`preview`, `request` exact-output, approve-if-needed, swap, `submit`), an **Altana client** wrapper (`execute` with the session, typed errors for `ExceededSpendLimit`, revoked and expired sessions), ERC-8004 registration, and the tx executor with `DRY_RUN`.
- `apps/agent`: the worker loop, the grammY bot, and the post checker.
- `apps/web`: Next.js. Booking form, wallet connect, a tagged USD₮ transfer, `/r/[id]` receipts, `/stats`.
- DB: Postgres in production (Neon free tier), SQLite for local dev and dry-run. Drizzle ORM.

### Booking state machine

```
CREATED ─pay detected─▶ PAID ─post seen & text matches─▶ LIVE ─hold window ends─▶ RELEASING ─swap+payout ok─▶ RELEASED
   │                     │                                 │                          │
   │ expires unpaid      │ post deadline passes             │ deleted / edited         │ cap exceeded / session revoked
   ▼                     ▼                                 ▼                          │ / expired / no quote
 EXPIRED               REFUNDING ◀─────────────────────────┘                          ▼
                         │ refund ok                                                HALTED (needs a human; money stays in the wallet)
                         ▼
                       REFUNDED
```

- Deterministic code decides release or refund. There's no AI in the money path. Text match: normalize whitespace, Unicode and link previews, then require an exact match. A small local similarity score is shown only as a diagnostic. No paid models.
- Every action has an idempotency key, and the tx hash is stored before the next step. Restarting the worker never pays twice.
- A cap or revoke failure goes to `HALTED`. It's never retried from a different wallet. That makes the Altana demo honest: the wallet stops the agent, not our code.
- Release order: Textile exact-output quote for the booked cNGN amount, approve if needed, swap (tagged), re-check the `expiresAt` clock, then a tagged cNGN `transfer` to the owner.

### Pricing

The owner sets a naira price. At booking, a Textile `preview` (exact-output, `buyAmount` = naira) gives the USD₮ cost. The sponsor pays that plus a 2% rate buffer. At release the agent buys exactly the naira amount. Any leftover buffer over $0.10 goes back to the sponsor in the same release step. If the rate moved more than 2% against us, the booking halts before swapping and the owner is asked to accept the lower amount or wait. Bookings are $2 minimum, so we stay above Textile's $1 floor.

### Post checking (how reliable, and where it stops)

1. **Bot updates.** As a channel admin, the bot receives `channel_post` and `edited_channel_post`. That gives us instant "posted" and "edited" signals. The Bot API has **no deletion event**.
2. **Existence check every 10 minutes:** `copyMessage` (or `forwardMessage`) from the channel into a private Pinhold log chat, then delete the copy. If the source message is gone, Telegram returns "message not found". This works for public and private channels.
3. **Public cross-check:** fetch `https://t.me/<channel>/<id>?embed=1` and compare the text. This is independent of the bot and gives a public link for the receipt. It only works for public channels.
4. **Deleted** means two consecutive failed checks, about 10 minutes apart. That tolerates a short Telegram outage.

Documented limits: deletion is detected within about 10 to 20 minutes, not instantly. An owner who removes the bot blinds check 1, but checks 2 and 3 still run (2 needs the bot, so removing the bot is treated as a breach after a grace period). Pinned or unpinned state and view counts aren't enforced.

## Day-by-day plan (today is Fri 20 Nov; the deadline is Mon 7 Dec, 09:00 UTC)

| Day | Work | Needs your yes |
|---|---|---|
| Fri 20 Nov | RULES_CHECK.md, this plan | — |
| Sat 21 | Scaffold the workspace, config, DB schema, attribution module + repo check, **state machine and tests** (live, deleted, edited, never posted, over cap, expired or revoked session) | — |
| Sun 22 | grammY bot (owner onboarding, sponsor booking), post checker (all 3 checks), Textile client with mocks, plus a **read-only mainnet `preview`** | — |
| Mon 23 | Altana wrapper (mocked), payment watcher, `DRY_RUN` end to end, minimal booking and receipt pages. **Dry-run working.** You make the repo public and enroll on Loops. | Enroll (you) |
| Tue 24 | AskBots review 1. Create the Altana wallet, grant the session, register ERC-8004, then one $1 tagged test and decode it (`verifyTx`) | Wallet, mainnet tx |
| Wed 25 | Altana livestream. Textile firm quote + one real swap, cap test, revoke test on a throwaway session. Fix review issues. | Mainnet tx |
| Thu 26 to Fri 27 | Web booking with wallet connect and a tagged transfer, receipt timeline with Celoscan links, `/stats` read from the chain. Deploy the worker and Vercel. | Deploy |
| Sat 28 to Sun 29 | **First real booking:** your channel owner plus client 1. Onboarding message, fixes from real use. | — |
| Mon 30 to Tue 1 Dec | Clients 2 and 3. Stablecoin Corridors livestream. Hardening, alerting to your Telegram. | — |
| Wed 2 to Thu 3 | x402 door (only if on schedule), more bookings, a refund case | — |
| Fri 4 | AskBots review 2, fixes | — |
| Sat 5 | README with live stats, record the demo video | — |
| Sun 6 | Submission text, X post draft, final check for placeholders. **Submit Sunday evening**, not Monday morning. | Submit (you) |

The refund case for the demo has to be real. We could use a booking where the owner and the sponsor agree in advance that the owner will take the post down early, and say so plainly in the video. I won't stage it as an accident.

## Hosting and cost

- Vercel Hobby (free) for `apps/web`, and Neon free Postgres.
- The worker needs to run around the clock. Options: your own machine (simplest, but it must stay on), or a small VPS. I'll keep it to a single `node` process with a Dockerfile, so it runs anywhere.
- Onchain: about 20 CELO for the Altana Keystore registration, plus about $10 of USD₮ for tests and the refund float. Sponsors pay their own bookings.
- AI: $0. No paid model anywhere.

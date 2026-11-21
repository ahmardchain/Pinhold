# Pinhold: architecture and plan

Tracks: 1 (Textile FX Stablecoin Corridors) and 3 (Self Agent ID, Verified Agent Payments). Altana was dropped on 20 Nov.

## Architecture (as built)

```
 Sponsor's agent (Self Agent ID key = its wallet)
   │ 1. POST /api/bookings          signed with Self headers
   │    → SelfAgentVerifier (401 if not a verified human's agent)
   │    → registry nullifier: one open escrow per human
   │    → owner must be Self-verified; Textile preview prices ₦ → USD₮ (+2% buffer)
   │ 2. POST /api/bookings/:id/pay  Self-signed again, then x402 (USD₮, Celo facilitator)
   ▼
 Pinhold agent (one Node process)
   ├─ API + receipts (/r/:id) + stats (/stats) + /agent.json (ERC-8004 agentURI)
   ├─ Telegram bot: owner onboarding (/register + Self link), channel_post, edited_channel_post
   ├─ Worker: every minute TICK; post existence checks every 10 min (copyMessage + t.me embed)
   ├─ State machine (pure) → decides release or refund
   └─ Executor (idempotent, signs → records → broadcasts, every tx tagged):
        release: Self registry check of owner + channel admin check + daily cap
                 → Textile exact-output swap USD₮→cNGN → cNGN transfer to owner → surplus to payer
        refund:  USD₮ back to the x402 payer only
 SQLite (one file): bookings, owners, timeline, tx hashes
```

The code layout is described in the README. Tests: `test/` (state machine, policy, attribution). Scripts: `demo:dry`, `preflight`, `check:turnaway`, `verify`, `register:agent`, `sponsor`.

## Done (20–21 Nov)

- State machine, policies, tests: 32 passing
- Self verification (sponsors), registry reads (nullifier, owner binding)
- x402 seller route with a dynamic per-booking price; settlement recorded through `onAfterSettle`
- Textile RFQ client: exact output, keyless takerProof or API key, approve-exact, tagged swap
- Telegram bot and post checks; worker; receipts; stats
- Sponsor agent CLI (Self signing plus x402 paying)
- ERC-8004 registration file and script
- Verify script
- Offline dry run: 17 checks passing. Read-only preflight: passes on testnet and mainnet. Real Self turn-away checked on Celo Sepolia.

## Plan to 7 Dec

| Day | Work | Needs your yes |
|---|---|---|
| Sat 21 – Sun 22 Nov | You: mock passport, test bot, faucets, x402 key → testnet run per `docs/TESTNET.md`. Me: fix whatever the live run finds; sponsor web page (if you agree) | — |
| Mon 23 | Testnet dry run complete: release and refund on testnet, `npm run verify` green. You make the repo public and enroll on Loops (tag issued). | Repo public, enroll (you) |
| Tue 24 | Self livestream, AskBots review 1. Mainnet identities: Pinhold Self Agent ID (your real passport), ERC-8004 register, PayTo registered at sign-up | Mainnet tx, registrations |
| Wed 25 – Thu 26 | Deploy the worker (your choice of host). First mainnet booking by you as a test sponsor (doesn't count as independent, but proves the rails). Fix review issues. | Deploy, mainnet |
| Fri 27 – Sun 29 | **Real bookings:** your channel owner plus client 1, and client 2. Onboard with `docs/ONBOARDING.md`. | — |
| Mon 30 – Tue 1 Dec | Clients 3+, more channels (target 3–5 channels, 3+ sponsors). One real, pre-agreed refund on mainnet. Stablecoin livestream. | — |
| Wed 2 – Thu 3 | Hardening from real use; README with live numbers from `npm run verify` | — |
| Fri 4 | AskBots review 2, fixes | — |
| Sat 5 | Record the 3–4 min demo video; X post draft (you post it, tagging @selfxyz and @Celo) | — |
| Sun 6 | Final README and PROOF.md from verify output; no placeholders; **submit Sunday evening** | Submit (you) |

The pre-agreed refund means the sponsor and the owner agree in advance that the post comes down early, and the video says so plainly. Nothing gets staged as an accident.

## Costs

Gas on Celo for swaps, payouts, refunds and registrations: about $1–3 of CELO. The first 100 x402 settlements are free. Sponsors pay their own bookings. AI: $0. There's no model anywhere in the money path, and none at all today.

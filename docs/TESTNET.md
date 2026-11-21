# Testnet dry run, step by step

Two levels:

1. **Offline** (no keys, no network): `npm run demo:dry`. It runs the real API, state machine and executor against mocks and checks 17 scenarios. Works right now.
2. **Testnet**: real Self Agent IDs (mock passports), real x402 payments on Celo Sepolia, real Textile swaps on BSC testnet, a real Telegram bot. No real money. The steps are below.

## What runs where on testnet

| Part | Chain | Token |
|---|---|---|
| Self Agent ID (Pinhold, sponsors, owners) | Celo Sepolia | — |
| x402 payment in, refunds out | Celo Sepolia | USDC (the only x402 asset on testnet) |
| Textile swap, cNGN payout | BSC testnet | USDT (18 decimals) → cNGN |

On mainnet all of this is on Celo with USD₮ and cNGN. The split exists only because Textile's RFQ sandbox runs on BSC testnet. That sandbox is only a few hundred naira deep, so testnet listings use about ₦300.

## Steps (about 45 minutes)

1. **Mock passport.** In the Self app: Settings → Manage ID documents → Generate Mock Document.
2. **Pinhold's agent.** Run `npm run register:agent -- self` and scan with the mock passport. The key is saved to `.self/pinhold-agent.key`. Put it in `.env` as `AGENT_PRIVATE_KEY` (never paste it in chat).
3. **Fund Pinhold's agent address** (printed in step 2). You need test CELO on Celo Sepolia (faucet.celo.org), and tBNB and testnet USDT on BSC testnet (the BNB Chain faucet). The USDT is for swaps. In testnet the incoming USDC stays on Celo Sepolia, so Pinhold needs its own USDT float on BSC testnet.
4. **x402 key.** At https://x402.celo.org, connect a wallet, Create API key, then set `X402_API_KEY`.
5. **Telegram.** Create a bot with @BotFather (`TELEGRAM_BOT_TOKEN`). Create a private group or channel for checks, add the bot, and set its id as `TELEGRAM_LOG_CHAT_ID`. Set your own chat id as `TELEGRAM_ADMIN_CHAT_ID`.
6. **Test channel.** Create a public test channel and add the bot as an admin with every permission off. In the bot, send `/register @yourtestchannel 0xYourOwnerWallet 300 1`. That's a 1-hour hold for testing. Scan the Self link with a second mock document, or the same one: the testnet registry has no cap.
7. **Run Pinhold.** In `.env` set `PINHOLD_NETWORK=testnet`, `DRY_RUN=false`, `MIN_BOOKING_USDT=0.05` and `PUBLIC_BASE_URL` (a tunnel URL is fine). Then run `npm run preflight` and `npm start`.
8. **Sponsor agent.** Copy `.env.sponsor.example` to `.env.sponsor`, then run `npm run sponsor -- register` (mock passport) and fund the printed address with test USDC from faucet.circle.com (Celo Sepolia).
9. **Turn-away.** `npm run check:turnaway -- $PUBLIC_BASE_URL` should print 401.
10. **Book.** Run `npm run sponsor -- book @yourtestchannel "Your test ad text"`. The bot DMs the owner the exact text. Post it in the channel. The receipt page shows the post going live. After 1 hour it releases: Textile swap and cNGN payout on BSC testnet.
11. **Refund.** Book again, post, then delete the post. Within about 20 minutes the sponsor's USDC is refunded on Celo Sepolia.
12. **Proof.** `npm run verify` rebuilds both bookings from the chain.

On a public deployment, step 7 needs `NODE_USE_ENV_PROXY=1` only if the host routes traffic through a proxy (this build container does; a normal VPS does not).

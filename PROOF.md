# Proof: how to check Pinhold's claims yourself

Pinhold's claims (bookings, USD₮ in, cNGN out, refunds, who got paid) can be rebuilt from public chain data. You don't need to trust Pinhold's database. It only lists the transaction hashes to look at.

## Rebuild every booking

```bash
git clone https://github.com/ahmardchain/Pinhold && cd Pinhold && npm ci
PINHOLD_URL=<Pinhold's public URL> npm run verify -- --scan <first block> --json proof.json
```

For each booking, `scripts/verify.ts` fetches every transaction receipt from the chain, decodes the ERC-20 `Transfer` logs and the ERC-8021 tag, and checks the following.

| Step | Check |
|---|---|
| Payment (x402) | USD₮ moved from the payer to Pinhold's wallet, for at least the quoted amount |
| Swap (Textile FX) | Sent to the Textile LimitOrderReactor `0xa9AA…35b3`. Pinhold's wallet received at least the booked cNGN. Tagged. |
| Payout | cNGN moved from Pinhold's wallet to the owner's payout wallet, for exactly the booked amount. Tagged. The owner's Self Agent ID NFT is owned by that same wallet on the Self registry. |
| Refund / surplus | USD₮ moved from Pinhold's wallet to the original payer only. Tagged. |
| Completeness (`--scan`) | Every USD₮ transfer into Pinhold's wallet since `<first block>` belongs to a booking. Nothing is unaccounted for. |

The summary it prints (bookings, released, refunded, stablecoin in, cNGN out, refunded, distinct paying wallets, untagged agent transactions) is the source of the README's headline numbers.

## Check the identities

- Pinhold's Self Agent ID: `GET https://agent-api.self.xyz/api/agent/info/42220/<agentId>`
- Pinhold's ERC-8004 registration: the `Registered` event on `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, whose agentURI is `/agent.json` on Pinhold's URL
- Any owner's verification: `ownerOf(agentId)`, `hasHumanProof(agentId)` and `isProofFresh(agentId)` on the Self registry `0xaC3DF9ABf80d0F5c020C06B04Cced27763355944`

## Check the rules in the code

| Claim | Code |
|---|---|
| Only deterministic code decides release or refund | `src/core/machine.ts` (pure function, tested in `test/machine.test.ts`) |
| Unverified agents are turned away before quoting or payment | `src/server.ts` `requireSelfAgent`, `src/chain/self.ts` `verifySponsor`, `scripts/check-turnaway.ts` |
| One open escrow per human, across all their agents | `src/core/policy.ts` `admitBooking` with the nullifier from `src/chain/self.ts` |
| cNGN can only go to the Self-verified owner's wallet | `src/core/policy.ts` `payoutTarget`, called in `src/executor.ts` right before each payout |
| Refunds can only go to the payer | `src/core/policy.ts` `refundTarget` |
| Daily outflow cap | `src/core/policy.ts` `checkDailyCap`, applied to swaps, refunds and surplus in `src/executor.ts` |
| Every Pinhold transaction carries the attribution tag | `src/chain/wallet.ts` `send` and `src/attribution.ts` |

## Current status

Nothing has run on mainnet yet: no enrollment, no keys, no mainnet transactions. What has been checked so far:

- 32 unit tests (`npm test`)
- an offline end-to-end dry run of 17 scenario checks (`npm run demo:dry`)
- read-only preflight checks on testnet and mainnet (`npm run preflight`)
- a real Self signature turned away by the Celo Sepolia registry (`npm run check:turnaway`)

This section gets replaced with the verify output once real bookings exist.

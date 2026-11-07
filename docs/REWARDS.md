# Rewards: funded by platform revenue

**Status: live since 7 November 2026 on Arc mainnet (5042).**

Every MemeVerse trade pays a 2% fee inside the market contract: 1% to the token's creator and 1% to
the MemeVerse treasury. Rewards come only from the treasury's 1%, so they are real USDC that the
platform has already earned, never points, inflation or a promise.

| Share of the treasury fee | Goes to | When |
| --- | --- | --- |
| 30% | Weekly trading pool, shared by everyone who traded that week in proportion to their volume | Every Monday 00:00 UTC |
| 20% | The wallet that referred the trader, for every trade after the referral was signed | Every Monday 00:00 UTC |
| 50% | Stays with the platform | — |

The first week runs from Saturday 7 November to Monday 16 November 2026; every later week is Monday
to Monday (UTC). Trades before 7 November do not count.

## Why it cannot be gamed

A trader's pool share equals 30% of the treasury fee their own trades paid, and a referrer earns 20%
of the treasury fee their invitees paid. One person, even with a self-referred second wallet, gets
back at most 50% of the 1% treasury fee they paid, while the trade costs them 2%. Trading against
yourself, on your own token or someone else's, always loses money. Self-referral of the same wallet
is ignored, the treasury never earns, and total rewards can never exceed half of actual revenue.

## Referrals

A connected wallet gets a stable random 12-character code (`/referral?ref=aB3_kD9-zX2q`). The code
contains no wallet address. An invitee connects their own wallet and signs a free EIP-191 message
bound to the domain, chain id, code, invitee wallet and a five-minute timestamp. One wallet can be
referred once and cannot switch referrers. Records live in `MEDIA_STORAGE_DIR/referrals/`. The API
publishes only counts per wallet (friends joined, friends trading), never who referred whom.

## Data and API

- The API's activity indexer reads every Bought/Sold event of both factories, including the
  treasury fee of each trade (`MEDIA_STORAGE_DIR/activity/state.json`).
- `src/rewards.js` holds the only implementation of the rules; the API, the payout script and the
  tests all use it.
- `GET /api/v1/rewards` returns this week's pool, trades, volume, the top-10 leaderboard, past weeks
  and recent payouts. `GET /api/v1/rewards/:wallet` returns one wallet's week, earned, paid, next
  payout and referral counts.

## Payouts

`npm run rewards:plan` (on the production host) prints every payout due, the treasury balance and
the safety ceiling without sending anything. `npm run rewards:pay` sends them from the treasury key.

- Only weeks that have ended are paid. Balances under 0.05 USDC carry over to a later payout.
- The total of all payouts can never exceed 50% of the treasury fees of ended weeks; the script
  refuses otherwise.
- The signing key must be the treasury that the factories pay their fee to.
- A lock file prevents concurrent runs. Each payout is written to
  `MEDIA_STORAGE_DIR/rewards/payouts.json` before it is sent, then marked `sent` and `confirmed`.
  A run refuses to start while any entry is still `pending`; check that transaction on the explorer
  and set its status before paying again. A `failed` entry is retried by the next run.

Back up `MEDIA_STORAGE_DIR` (media, referrals, activity index and payout ledger) together.

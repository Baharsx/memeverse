# Security Policy

MemeVerse markets are live on Arc mainnet, chain `5042`. A trade is signed by the visitor's own wallet and settled by the market contract. USDC on that chain is real money, and USDC is also the gas. Creator and treasury fees move inside the same trade. The server does not hold the market, does not sign trades, and does not pay creators.

There is no Circle settlement and no agent wallet. Those routes were removed. Nothing in this repository spends from a platform wallet when someone buys or sells.

There is no independent audit. MemeVerse is not an official partner of Arc. NFT and the vault are in the application and are not deployed on this mainnet, so that wider product is not mainnet-ready. MemeVerse does not provide financial advice, and it does not offer support through unsolicited direct messages.

This repository is released under the MIT License in [`LICENSE`](./LICENSE). Copyright (c) 2026 Soheil SL. The file is the full MIT text, including the warranty disclaimer and the liability limit. A market that moves real USDC does not add a warranty the license does not give.

## User safety

- Check Arc for yourself at <https://docs.arc.io/> and <https://status.arc.io/>.
- The live site is chain `5042`. Arc testnet is chain `5042002` and is not this deployment. Read the chain id in the wallet before you sign.
- Never share a seed phrase, private key, one-time code, or wallet backup. Not with MemeVerse, not with someone claiming to be support, and not in a GitHub issue.
- Treat unsolicited support messages, token claims, role offers, and requests to install unknown software as hostile.
- Read the wallet's transaction preview and the destination before you sign. A transaction hash is not a receipt until the transaction is confirmed successfully.
- Mainnet USDC has real value. A loss on a trade is a real loss.

## Onchain markets

- The factory's USDC, treasury, and fee configuration are immutable. There is no admin key that can change them, and the market contracts expose no withdrawal or arbitrary-call function.
- Fees are capped in the contract. The live factory charges 1% to the creator and 1% to the treasury, taken from the executed trade.
- Buys and sells use the six-decimal USDC contract. A buy quotes a maximum. The market transfers the curve cost plus the fees, and leaves the rest of the allowance alone.
- The site must not show a trade as successful before Arc confirms the receipt.
- A market that has sold its whole supply is sold out. It is not a market with a zero price.

## The server

- The API serves health and media. It does not settle trades, and it does not open a settlement database.
- A media upload requires the application origin, a short-lived creator signature, and a rate limit. A foreign origin is rejected.
- `X-Forwarded-For` is ignored unless a trusted proxy hop count is configured.
- The API sends a Content Security Policy with no wildcard source and no `'unsafe-eval'`. The static site sends `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Content-Security-Policy: frame-ancestors 'none'`.
- Public responses and logs must not contain private keys, session tokens, cookies, or wallet signatures.

## Secrets

- No private key may be committed, logged, or placed in a `VITE_*` variable. Only public browser configuration belongs in `VITE_*`.
- Leftover Circle credentials in a server environment are unused. They must not be pointed at mainnet, and they must not be copied into the browser bundle.

## Reporting a vulnerability

Do not publish exploitable details, credentials, wallet data, or user information in a public issue. Contact the repository owner through the verified GitHub account and include the smallest reproduction that still shows the problem, with every secret removed.

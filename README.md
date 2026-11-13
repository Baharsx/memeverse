# MemeVerse — shut down

**MemeVerse was shut down on 2026-11-13 and will not be continued.**

The website (memeverse.biz) and its API are offline and have been removed from the server. This
repository is archived and kept read-only for reference. There is no support, no new release and no
further development.

## If you hold a MemeVerse token

The markets are smart contracts on Arc mainnet (chain `5042`). They have no admin key and cannot be
paused or switched off, so they keep working without the website. You can still sell your tokens
back to the market contract from the wallet that holds them.

| Market | Symbol | Contract |
|---|---|---|
| MEMEVERSE GENESIS | MMV | `0xDCa07Bd83bc7A4220C79afB60F8C2Bb7DC746932` |
| Flash | FLS | `0x52e1d2a7ECe14cb84aA74687Fafe40D5794de2fF` |
| UCat | UCAT | `0x1Cb84539b3FCFEd5c01d4b805Fe9aD38214aFB00` |
| doge lord | DLORD | `0x75115A62D31bC4B9289b9CA89BFE5663B80B9358` |
| Doge Rocket | DGR | `0xE56C90df9b96e1Ff55E2f280C03Ace846A01e54C` |
| Magic hand | MGH | `0x2f212429FC9B78c58EcFDe64F62c6f11e914555D` |

All six were created by factory `0x177492EFFbe5F7847994696ef4C9B24b8C9C13BE`. The market contract is
also the token contract.

To sell:

1. Read `quoteSell(uint256 tokenIn)` on the market to see the USDC you would receive (`usdcOut`,
   six decimals).
2. Call `sell(uint256 tokenIn, uint256 minimumUsdcOut)` from your wallet. No approval is needed.

`tokenIn` is in 18-decimal units and must be whole tokens: 3 tokens is `3000000000000000000`.
Use the `usdcOut` from step 1, or slightly less, as `minimumUsdcOut`. USDC is also the gas token on
Arc, so keep a little USDC in the wallet. The contract source is in [`contracts/`](./contracts) and
its ABI in [`contracts/artifacts/MemeMarket.json`](./contracts/artifacts/MemeMarket.json).

Check the chain id in your wallet before you sign. Nobody from MemeVerse will contact you; treat any
message offering help, refunds or a migration as a scam.

## Rewards

The rewards program ended with the shutdown. No payouts are pending.

## License

[MIT](./LICENSE). Copyright (c) 2026 Soheil SL.

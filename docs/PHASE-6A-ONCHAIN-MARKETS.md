# Phase 6A onchain market record

Date: 2026-08-02
Network: Arc Public Testnet (`5042002`) only

## Live contracts

| Contract | Address | Deployment / creation transaction | ArcScan source |
|---|---|---|---|
| MemeVerseFactory | `0x765E2Eaaba8eaEF4437B15CF42C1F268D3c8c08F` | `0x1beb6371c9a50cba115044d6002f671fb1895d59fcae5302a46193c836bc8020` | Fully verified |
| MMV6A MemeMarket + token | `0x5CcB34ec32e5ea12CdD7119157De9b8207b8880D` | `0xcb4020a1708487c4a31bbe25f763b4969de4b735530feec947bff5286c125278` | Fully verified |

The immutable factory configuration is official Arc Testnet USDC `0x3600000000000000000000000000000000000000`, treasury `0x6bbD385C0f51D273a1685C977fAfa179F9eEb689`, creator fee 100 bps, and treasury fee 100 bps. Combined fees are contract-capped at 500 bps.

## Real transaction pass

| Operation | Transaction | Verified result |
|---|---|---|
| Approve | `0x7a44e1caa32346b6206bda8ce0896f35a794155abbb4bccdec566657b655a5e2` | Exact 0.01 USDC allowance |
| Buy | `0x62cfc205277c34da50a1763f727b190753445c2947010ba09770b2f3b8bff732` | 0.01 USDC in, 97 MMV6A out |
| Sell | `0x5af385b082c7b4de0c338717e9923608c0aafa1424a70849cd7bb1ca8a514a07` | 48 MMV6A in, 0.004739 USDC out |

Final checked state was 49 MMV6A held by the E2E wallet, 49 whole tokens sold, 0.004911 USDC curve reserve, 0.004965 actual market USDC balance, and 0.000148 USDC recorded for each creator and treasury allocation. Runtime bytecode, immutables, registry membership, reserve solvency, and the fixed-supply invariant passed `npm run markets:audit:onchain`.

## Economic and security limits

The cumulative curve is `C(q) = bq + floor(mq(q-1)/(2(T-1)))` in six-decimal USDC units. Buys binary-search the greatest whole-token output affordable after fees; sells reverse the exact cumulative curve interval. Every trade enforces a caller-supplied minimum output.

This MVP trades whole tokens only, has no external liquidity or price oracle, can retain non-withdrawable buy rounding surplus, and is not independently audited. The contracts have no upgrade, admin mutation, arbitrary call, or withdrawal path. Mainnet use is prohibited.

NFT and legacy Vault surfaces remain simulations for Phase 6B.

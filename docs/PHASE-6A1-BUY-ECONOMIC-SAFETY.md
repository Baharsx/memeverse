# Phase 6A.1 buy economic safety record

Date: 2026-08-02
Network: Arc Public Testnet (`5042002`) only

## Corrected economics

The buy input is `maximumUsdcIn`. For every candidate whole-token count, the market computes the exact cumulative curve interval, then derives creator and treasury fees from that executed curve value. The greatest candidate satisfying the maximum is returned.

```text
creatorFee = floor(curveCost × creatorFeeBps / 10,000)
treasuryFee = floor(curveCost × treasuryFeeBps / 10,000)
actualUsdcSpent = curveCost + creatorFee + treasuryFee
```

`buy` transfers only `actualUsdcSpent`. Approval may cover the maximum, but unused maximum budget remains in the buyer's wallet and allowance. Each fee rounds down by less than one six-decimal USDC atomic unit. Selling the purchased interval reverses the identical cumulative curve cost before applying the same fee basis.

## Current contracts

| Contract | Address | Deployment / creation transaction | ArcScan source |
|---|---|---|---|
| MemeVerseFactory 6A.1 | `0x363124490E953EEbB414eB4c3e2f03a40eef8F2C` | `0xfc4aff2c762edae0d94c6a68a0bd77f6cfbd451f597e066801cba12faee66307` | Fully verified |
| MMV6A1 MemeMarket + token | `0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D` | `0x89fbc6f27d51457741dc58df278915628b928bb5efa70f2113074be3cad7e8e7` | Fully verified |

## Real transaction pass

| Operation | Transaction | Verified result |
|---|---|---|
| Approve maximum | `0x9c3ec3d3d3b35dffe8b6433eaf523dde202d3a073f8cb2f3c8dd137910159aea` | 0.01 USDC maximum allowance |
| Buy | `0x11b8dbd52d2db6a3f843b41771078ed0ad0f8fb62c76d7740e8d14f514e8c2b2` | Maximum 0.01; actual 0.009940 USDC; unused 0.000060; 97 MMV6A1 out |
| Sell | `0x8b69b0c7189ae20081d3783ddb3eb6e488081d909d334bfff1c3cc8858468bec` | 48 MMV6A1 in; 0.004739 USDC out |

The buy's executed curve value was 0.009746 USDC, with 0.000097 USDC allocated to each fee. Final state is 49 MMV6A1 held, 0.004911 USDC curve reserve, exactly 0.004911 USDC held by the market, and 0.000145 USDC cumulative in each fee bucket.

The Phase 6A factory `0x765E2Eaaba8eaEF4437B15CF42C1F268D3c8c08F` and market `0x5CcB34ec32e5ea12CdD7119157De9b8207b8880D` are explicitly legacy and remain documented in [`PHASE-6A-ONCHAIN-MARKETS.md`](./PHASE-6A-ONCHAIN-MARKETS.md).

Deployment and E2E Circle idempotency keys are now deterministically bound to artifact bytecode, addresses, and operation parameters. Safe retries reuse an operation, while any artifact or target change produces a distinct UUID-form key.

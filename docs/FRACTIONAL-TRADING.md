# Fractional trading: separate version-2 deployment

The existing `MemeMarket` contracts are immutable. Their buy search counts whole tokens and their sell function rejects fractional inputs. They cannot be upgraded by changing the frontend, their factory, or an environment variable.

`MemeFractionalMarket` and `MemeVerseFractionalFactory` add actual 18-decimal purchases and sales. These are separate contracts and new token addresses. An existing token's balances, USDC reserve, creator, artwork, and transaction history remain in its original contract. No migration, duplicate token launch, balance transfer, or mainnet transaction is automatic.

## Accounting

With supply `T`, base price `b`, slope `s`, and circulating token amount `x`, the continuous cumulative curve is `C(x) = b*x + s*x*x/(2*T)`. Solidity accepts token amounts in 18-decimal atomic units and produces 6-decimal USDC amounts. Each term rounds down. The whole-token v1 curve is preserved in its original source and contracts; it is not silently reinterpreted.

Buy and sell costs are differences of the same cumulative function. Consequently `reserveUsdc == cumulativeCurveCost(soldTokenUnits)` after every successful trade. Fees are calculated separately from the executed curve value and transferred to the immutable creator and treasury. A buy binary-searches the greatest affordable atomic token amount. A zero-USDC purchase or a sale with zero USDC curve value is rejected. USDC's six-decimal precision remains the lower limit on redeemable value.

For a base price of 1 USDC with 1% creator and 1% treasury fees, a 1-USDC budget buys approximately 0.98039 tokens, with the exact amount depending on the curve and six-decimal fee rounding. This is an onchain amount, not a UI division of the budget by the displayed price.

## Compatibility and activation

The frontend loads the original factory and an optional `VITE_FRACTIONAL_FACTORY_ADDRESS`. New launches use the fractional factory only when that separate address is configured. The API trusts the same two registries for creator-authenticated artwork. Original markets retain their actual quotes and whole-token sell restrictions. Fractional markets use decimal input, exact atomic parsing, fractional circulation, and nonzero quote display even below six decimal places.

Run `npm test`, `npm run test:ui`, and `npm run contracts:compile` before preparing a deployment. `node scripts/deploy-fractional-factory.js` is read-only by default: it verifies mainnet, reads the legacy factory's treasury and fee configuration, estimates deployment gas, and prints a bytecode hash and budget. It never changes the live configuration or creates token markets.

Only `--broadcast` signs a deployment. It requires an explicit `FRACTIONAL_DEPLOY_STATE` path and an available deployment budget. The state file prevents concurrent or repeated broadcasts and records the transaction hash before receipt verification. Any interrupted deployment must be inspected by hash before another attempt. Source verification and version, USDC, treasury, fee, bytecode, and chain checks precede configuring the address on the application.

To create a fractional version of an existing token, its creator must launch a new token from their own wallet. That new token has a new address and a separate supply and reserve. Existing holdings do not become holdings of the new token. Any proposed migration must specify how holders and existing reserves are treated before it is implemented or announced.

## Validation

Contract tests cover fractional buying and selling, arbitrary 18-decimal token amounts, maximal affordable quotes, partial and complete reversals, repeated trades, exact reserve backing, maximum supply and pricing, fee rounding, slippage, currency failures, reentrancy, and fractional transfers. Legacy contract tests remain unchanged. Browser tests cover fractional quote display and sell parsing alongside truthful legacy quotes and removal of the minimum-purchase message.

## Mainnet deployment

- Factory: `0xa247486939e1E85916bd90b10c9D6eadf3fF3e27` (Arc mainnet, chain 5042)
- Transaction: `0xc7433b18e0df7a12097cf99864b00849270353bbec79fd85661ec4091f40cb2f`, block 29854964, November 6, 2026
- Constructor: Arc USDC, treasury `0x5A119569569907B5D8bb94efA84375682240A85c`, creator fee 100 bps, treasury fee 100 bps
- Source: Sourcify exact match for creation and runtime bytecode
- Production configuration: `VITE_FRACTIONAL_FACTORY_ADDRESS` in `/etc/memeverse/memeverse.env`; the deploy record at `/opt/memeverse-releases/fractional-factory-deploy.json` blocks a repeated broadcast.

The six markets of the original factory remain whole-token markets. When a budget is below one whole token, their buy form shows one line explaining it; fractional markets never show it.

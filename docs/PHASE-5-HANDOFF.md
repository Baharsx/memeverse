# Phase 5 presentation handoff

> Historical handoff: Phase 6A supersedes the market-launch statements below. Market creation and USDC buy/sell are now live on Arc Public Testnet; NFT and legacy Vault experiences remain simulations.

MemeVerse is ready to present as an independent product **built on Arc**. The final MVP separates live infrastructure from safe simulations and never implies that MemeVerse is an Arc or Circle product.

## Three-minute demo path

1. Open `/memeverse/`. Point out the live Arc RPC block, PostgreSQL, Circle Wallet, and Circle quote status cells.
2. Open **Quote**. Request the default `0.01 USDC → EURC` estimate. Explain that the Kit Key stays server-side, the provider response is validated, transaction data is discarded, and nothing is signed or broadcast.
3. Open **Agent**. Submit the default `1.00 USDC` request. Walk through the weighted signal score, enforced limits, PostgreSQL reservation, reconciliation memo, and Circle execution plan.
4. Select **Review human execution** only to demonstrate the safety gate. Do not type `EXECUTE` unless a deliberate testnet broadcast is intended and every displayed field has been verified.
5. Open **Proof**. Show the verified MemeVerseSettlement address, official Arc resources, explicit transaction lifecycle, Testnet warning, and brand-language statement.

## Claims that are safe to make

- MemeVerse is built on Arc Testnet and uses USDC for gas and settlement.
- The Agent may evaluate, quote, reserve, and prepare; a human is required to execute.
- Circle Developer-Controlled Wallet infrastructure is configured for an Arc Testnet EOA.
- The MemeVerseSettlement source is verified on ArcScan.
- The Circle Stablecoin Kits experience performs a real authenticated estimate and does not broadcast.
- NFT and legacy Vault experiences are simulations. Market launch and trading became real wallet-signed Arc Testnet flows in Phase 6A.

Do not claim Arc or Circle endorsement, partnership, mainnet readiness, autonomous signing, production analytics, real asset value, or current post-quantum protection.

## Presenter preflight

```bash
npm run db:migrate
npm run dev:api
npm run dev:worker
npm run dev:web -- --host 127.0.0.1
```

Then verify:

```bash
curl -fsS http://127.0.0.1:8787/api/health
npm run app-kit:verify
npm run contracts:audit:onchain
npm run check
npm audit --audit-level=low
```

Expected presentation state:

- API reports `status: ok`, Arc `verified`, persistence `ready`, Circle configured, and the server-side Circle quote runtime enabled.
- Circle quote verification returns an estimate without a transaction broadcast.
- Automated test, build, dependency audit, and read-only onchain audit complete successfully.

## Recovery notes

- If Arc or Circle is degraded, leave execution disabled and present the fail-closed state honestly.
- Never retry an unknown or post-broadcast failure blindly; reconcile the existing record first.
- Never expose `.env.local`, the Circle API key, entity secret, Kit Key, database credentials, wallet backup, private key, or seed phrase.
- Use only official Arc documentation, Arc status, ArcScan, and the Circle faucet linked from the Proof screen.

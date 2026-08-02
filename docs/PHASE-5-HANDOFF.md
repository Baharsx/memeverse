# Phase 5 presentation handoff

MemeVerse is ready to present as an independent product **built on Arc**. The final MVP separates live infrastructure from safe simulations and never implies that MemeVerse is an Arc or Circle product.

## Three-minute demo path

1. Open `/memeverse/`. Point out the live Arc RPC block, PostgreSQL, Circle Wallet, and App Kit status cells.
2. Open **App Kit**. Request the default `0.01 USDC → EURC` estimate. Explain that the Kit Key stays server-side, the provider response is validated, transaction data is discarded, and nothing is signed or broadcast.
3. Open **Agent**. Submit the default `1.00 USDC` request. Walk through the weighted signal score, enforced limits, PostgreSQL reservation, reconciliation memo, and Circle execution plan.
4. Select **Review human execution** only to demonstrate the safety gate. Do not type `EXECUTE` unless a deliberate testnet broadcast is intended and every displayed field has been verified.
5. Open **Proof**. Show the verified MemeVerseSettlement address, official Arc resources, explicit transaction lifecycle, Testnet warning, and brand-language statement.

## Claims that are safe to make

- MemeVerse is built on Arc Testnet and uses USDC for gas and settlement.
- The Agent may evaluate, quote, reserve, and prepare; a human is required to execute.
- Circle Developer-Controlled Wallet infrastructure is configured for an Arc Testnet EOA.
- The MemeVerseSettlement source is verified on ArcScan.
- The App Kit experience performs a real authenticated estimate and does not broadcast.
- Market launch, NFT, and vault experiences are simulations.

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

- API reports `status: ok`, Arc `verified`, persistence `ready`, Circle configured, and App Kit runtime enabled.
- App Kit verification returns an estimate without a transaction broadcast.
- Automated test, build, dependency audit, and read-only onchain audit complete successfully.

## Recovery notes

- If Arc or Circle is degraded, leave execution disabled and present the fail-closed state honestly.
- Never retry an unknown or post-broadcast failure blindly; reconcile the existing record first.
- Never expose `.env.local`, the Circle API key, entity secret, Kit Key, database credentials, wallet backup, private key, or seed phrase.
- Use only official Arc documentation, Arc status, ArcScan, and the Circle faucet linked from the Proof screen.

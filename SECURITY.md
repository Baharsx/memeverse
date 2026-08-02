# Security Policy

MemeVerse is currently a public Arc Testnet MVP. Its backend can authorize a Circle Developer-Controlled EOA call through Arc Memo only after server credentials and the verified settlement contract are configured and the user explicitly executes a prepared settlement. It does not accept mainnet assets, provide financial advice, or offer support through unsolicited direct messages.

## User safety

- Verify Arc network information against `https://docs.arc.io/` and network health against `https://status.arc.io/`.
- Confirm Arc Testnet chain ID `5042002` before signing.
- Never share a seed phrase, private key, one-time code, or wallet backup with MemeVerse, Circle, Arc community members, or anyone claiming to provide support.
- Treat unsolicited support messages, token claims, role offers, and requests to install unknown software as hostile.
- Inspect the wallet simulation and destination before signing. A transaction hash is not a receipt until the transaction is confirmed successfully.
- Arc Testnet assets have no real-world value.

## Application security requirements

- No private key or privileged Circle credential may be bundled into the browser application or committed to Git.
- The browser may suggest an amount or recipient, but the backend remains authoritative for limits, chain selection, quote expiry, and allowed state transitions.
- Settlement creation must include an idempotency key. Reusing a key with a changed payload must fail closed.
- Persistent PostgreSQL/PGlite settlement data must remain outside Git with owner-only filesystem and database access.
- Circle API keys and entity secrets belong only in `.env.local` or a production secret manager. They must never use a `VITE_*` prefix.
- The Circle entity-secret recovery file must be stored separately from the application and source repository.
- Circle webhook processing requires valid `X-Circle-Signature` and `X-Circle-Key-Id` headers over the exact raw body.
- Webhooks are at-least-once and potentially out of order; notification IDs must be deduplicated and older states must not regress settlement state.
- A Circle transaction in `INITIATED`, `CLEARED`, `QUEUED`, or `SENT` is not final. Only independently reconciled completion may close the settlement.
- Circle `COMPLETE` alone is not application completion. The Arc receipt must succeed and contain the expected Memo, SettlementExecuted, and USDC Transfer events with matching sender, target, recipient, amount, memo ID, and calldata hash.
- Treasury capacity must be reserved transactionally before an approved quote is returned. Expired and pre-broadcast failed reservations must be released; verified settlements must be consumed.
- A post-broadcast failure or event mismatch must hold its reservation for manual resolution; it must never silently return uncertain funds to available capacity.
- Agent decisions must enforce evidence freshness, confidence, fraud-risk, treasury capacity, and a UTC daily payout cap in the backend. The agent may quote and prepare but may never execute.
- `MANUAL_DEMO` signal provenance is Testnet-only and must not be treated as authenticated analytics.
- Production must use managed PostgreSQL. PGlite is single-process development storage and must not be shared between the API and a continuous worker.
- Production database migrations must run as a separate one-shot command. API and worker identities should not receive DDL privileges.
- Reconciliation workers must claim records through expiring database leases; Circle webhook IDs must be deduplicated in PostgreSQL.
- Kit Keys are server-only secrets. The active Stablecoin Kits path may prepare estimates only, must verify echoed request parameters, and must never return prepared transaction data; all execution capabilities remain disabled pending separate review.
- The MemeVerseSettlement allowance must remain bounded. Never grant an unlimited allowance merely for convenience.
- Contract source, compiler version, optimizer settings, constructor arguments, deployed bytecode, and operator address must remain independently reproducible.
- MemeVerse markets are Arc Public Testnet-only, non-upgradeable, and unaudited. The factory fee configuration is immutable and capped at 5% combined; the deployed configuration is 1% creator plus 1% treasury.
- Market trades use only the official six-decimal USDC ERC-20 interface. Buy/sell amounts, quotes, allocations, reserve state, and slippage bounds must remain integer onchain values.
- Buy input is a maximum, never a mandatory charge. Fees must derive from executed curve value, and `buy` may transfer only the quoted curve cost plus those fees; unused allowance and wallet budget must remain untouched.
- Market contracts have no admin withdrawal or arbitrary-call surface. Their actual USDC balance must remain greater than or equal to the curve reserve, and fixed supply must equal market inventory plus sold whole-token units.
- Browser market actions must never report success before a successful final Arc receipt. A submitted hash remains pending evidence, not success.
- Production services must validate chain ID, contract address, recipient, amount, fee assumptions, and transaction status server-side.
- Webhooks must be authenticated and deduplicated by notification ID because delivery can be at least once.
- Retry logic must distinguish pre-broadcast failures from submitted transactions and persist the latest transaction hash before retrying.
- Transaction Memo and Multicall3From flows must use a directly signing EOA until Arc documentation states otherwise; smart contract wallets are not supported as direct callers.

The Phase 4 threat model, residual risks, and onchain read-only checks are documented in [`docs/PHASE-4-SECURITY-REVIEW.md`](./docs/PHASE-4-SECURITY-REVIEW.md).

## Reporting a vulnerability

Do not publish exploitable details, credentials, wallet data, or user information in a public issue. Contact the repository owner through the verified GitHub account and include minimal reproduction steps without secrets.

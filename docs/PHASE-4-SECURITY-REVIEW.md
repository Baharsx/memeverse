# Phase 4 security review

Date: 2026-08-02  
Scope: `MemeVerseSettlement`, Arc Memo execution, Agent Policy V2, persistence, webhook deduplication, and reconciliation workers.

This is an internal engineering review, not an independent professional audit. Mainnet deployment remains prohibited until an external smart-contract review is complete and Arc publishes supported mainnet parameters.

## Security invariants

1. Only the configured Circle EOA can call `settle` through Arc Memo.
2. A settlement ID can be consumed only once.
3. Zero IDs, recipients, and amounts revert.
4. A failed USDC `transferFrom` reverts the `settled` write.
5. Circle `COMPLETE` is insufficient; Memo, SettlementExecuted, and ERC-20 USDC Transfer events must all match.
6. Agent Policy V2 may quote and prepare but cannot execute a financial transaction.
7. Treasury balance, active/held reservations, and the autonomous daily cap are checked in one serialized database transaction. Post-broadcast ambiguity remains held.
8. Webhook notification IDs are deduplicated in PostgreSQL.
9. Multiple workers claim reconciliation records through expiring database leases.
10. Production refuses to start without `DATABASE_URL`.
11. Production runtime migrations are disabled; a separate DDL identity runs `npm run db:migrate`.

## Threat review

| Threat | Control | Residual risk |
|---|---|---|
| Unauthorized payout | Immutable operator check and fixed settlement contract | Circle credential compromise still requires incident response and allowance revocation |
| Duplicate payout | Onchain `settled` mapping plus API idempotency | A different settlement ID is a distinct authorization; upstream evidence must remain unique |
| Concurrent overspend | Transactional treasury and daily reservations | Circle balance can change outside MemeVerse between quote and execution |
| Forged agent signal | Provenance, freshness, confidence and fraud-risk fields are persisted | `MANUAL_DEMO` evidence is not cryptographically trusted and must not be treated as production analytics |
| Provider says complete but chain differs | Independent receipt and three-event verification | RPC availability can delay completion but cannot create a false success |
| Duplicate workers | PostgreSQL `FOR UPDATE SKIP LOCKED` lease claim | A worker can retry after lease expiry; reconciliation remains idempotent |
| Webhook replay | PostgreSQL primary key and advisory lock | Authentic notifications can arrive out of order; state transition rules still apply |
| Supply-chain compromise | Runtime dependency audit and minimal native-fetch Stablecoin Kits boundary | Full official App Kit packages remain excluded; the active quote-only path has no added runtime dependencies |

## App Kit decision

Arc App Kit capabilities are exposed through a narrow backend boundary. The latest official `@circle-fin/app-kit@1.11.0` and `@circle-fin/adapter-circle-wallets@1.5.0` packages were re-evaluated on 2026-08-02 but are not shipped because their dependency graph still introduced 25 low/moderate runtime findings, including legacy elliptic and UUID paths.

MemeVerse enables only authenticated Swap Estimate through Circle's Stablecoin Kits HTTPS service contract using Node's native `fetch`. The Kit Key remains server-only, the request requires a live Circle wallet on Arc Testnet, echoed wallet/token/amount fields are verified, provider errors are redacted, timeouts fail closed, and prepared transaction data is discarded. Send, Bridge, swap execution, and Unified Balance are reported as disabled. This keeps the application dependency audit at zero while providing a real, non-transactional Arc Testnet quote path.

## Verification commands

```bash
npm test
npm run build
npm audit
npm run app-kit:verify
npm run contracts:compile
npm run contracts:audit:onchain
```

The onchain audit is read-only. It checks deployed bytecode, immutable operator and USDC values, the known completed Phase 3 settlement, unauthorized access, zero-ID rejection, and duplicate-ID rejection through `eth_call` simulation.

## Required before mainnet

- Independent Solidity audit and remediation sign-off.
- Rotation and incident-response runbook for Circle API credentials and entity secret.
- Allowance revocation drill and treasury isolation.
- Authenticated analytics pipeline; disable `MANUAL_DEMO` signals in production.
- Managed PostgreSQL with encrypted transport, backups, point-in-time recovery, and least-privilege API/worker roles.
- Separate allow/deny reviews before enabling App Kit Send, Bridge, swap execution, or Unified Balance.

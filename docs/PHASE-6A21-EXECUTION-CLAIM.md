# Phase 6A.2.1 — Atomic execution claim

A final review of Phase 6A.2 found one remaining concurrency gap. This patch closes it and
tightens two smaller configuration and housekeeping issues. It changes no contract, deploys
nothing, and spends nothing.

## The race

Phase 6A.2 made an execution authorization single-use and settlement-bound, but nothing stopped
a settlement from having **two** valid authorizations outstanding at the same time. The old
`SettlementService.execute` then ran:

```text
consume authorization  →  read AWAITING_SIGNATURE  →  persist authority  →  call Circle
```

The settlement stayed executable for the whole window between persisting the authority and
persisting the Circle transaction ID. Two concurrent callers could therefore both pass the state
check, and the optimistic version check did not help: the loser simply reloaded, saw a record
that was still `AWAITING_SIGNATURE` with no transaction ID, and wrote its own authority on top.

Reproduced against the pre-patch code in `server/test/execution-claim.test.js`:

| Scenario | Provider calls before the patch | After |
|---|---|---|
| Two valid authorizations, executed concurrently | **2** | **1** |
| Twenty concurrent execute requests | **6** | **1** |
| Ten concurrent requests against PGlite | **6** | **1** |

The last row matters: the flaw was not an artefact of the in-memory store. It reproduced against
a real PostgreSQL-compatible engine.

Circle's idempotency key would very likely have prevented two distinct transfers, but relying on
a provider for the application's own mutual exclusion is not a control. It also left the record
itself wrong: authority B could be persisted while authority A owned the provider call.

## The atomic claim

Execution now passes through one durable, database-level gate before Circle is contacted.

```text
read record (with version)
      ↓
assert state, binding, and mode
      ↓
atomic conditional UPDATE  ← the only gate
      ↓  (commits, transaction closes)
winner alone calls Circle, outside any database transaction
      ↓
persist provider result with optimistic concurrency
      ↓
reconcile
```

`SettlementStore.claimExecution` is a single statement:

```sql
UPDATE settlements
   SET record = …, execution_claim_id = …, execution_claim_until = …, version = version + 1
 WHERE id = $1
   AND version = $expectedVersion
   AND state = 'AWAITING_SIGNATURE'
   AND circle_transaction_id IS NULL
   AND (execution_claim_id IS NULL OR execution_claim_until <= $now)
RETURNING record, version
```

When it matches no row, the store re-reads the row as it actually stands and returns exactly why:

| Outcome | Meaning | Domain response |
|---|---|---|
| `CLAIMED` | This caller owns the submission | Proceed to Circle |
| `ALREADY_SUBMITTED` | A provider transaction already exists | Reconcile; never submit again |
| `ALREADY_CLAIMED` | Another caller holds an unexpired claim | `409 EXECUTION_ALREADY_CLAIMED` |
| `NOT_EXECUTABLE` | State moved on | `409 SETTLEMENT_NOT_EXECUTABLE` |
| `VERSION_CONFLICT` | The row moved; still claimable | Reload, re-evaluate, retry (bounded) |
| `NOT_FOUND` | Row gone | `404 SETTLEMENT_NOT_FOUND` |

**Deployment note:** this release adds `settlements.execution_claim_id` and
`settlements.execution_claim_until`. They are created by the existing one-shot migration
(`ADD COLUMN IF NOT EXISTS`), so run `NODE_ENV=production npm run db:migrate` with the
`DATABASE_MIGRATION_URL` identity **before** rolling out the new API and worker.

> **Corrected in Phase 6A.2.2.** This note originally warned that the runtime readiness check
> verified table existence only, so an un-migrated database would fail on the first write rather
> than at startup. Readiness now verifies every required column and refuses to start against an
> outdated schema. See
> [`PHASE-6A22-EXECUTION-LIFECYCLE.md`](./PHASE-6A22-EXECUTION-LIFECYCLE.md).

Ownership is never inferred from an in-memory snapshot. The `execution_claim_id` and
`execution_claim_until` columns are projected from the persisted `executionSubmission` on every
write path, so the generic optimistic update keeps them consistent automatically.

`MemorySettlementStore` and `JsonSettlementStore` implement the identical contract — the memory
store performs its check-and-set with no intervening `await`, so it is indivisible on the event
loop exactly as the SQL statement is.

### Authority immutability

The winning `executionAuthorization` is written by the claim itself. While a claim is live, no
other caller can reach the update at all, so `operatorAddress`, `sessionId`, `authorizationRef`,
`bindingHash`, and `executionMode` cannot be replaced. Once a Circle transaction ID exists, every
later `execute` reconciles instead of claiming, so the winner's authority survives permanently.

> **Amended in Phase 6A.2.2.** That held only while a claim was live or a transaction existed. A
> *resumed* claim, taken after a lease expired, did overwrite `executionAuthorization`, so the
> root record attributed the provider operation to the recovering authority rather than the
> originating one. `executionAuthorization` is now immutable for the settlement's whole lifetime,
> and per-attempt authority lives in `executionAttempts`.

### Binding re-check

The transport validates the approval binding when it consumes the authorization. The domain now
re-checks `settlementExecutionBindingHash(record)` inside the claim as well, closing the window
between those two steps. A settlement whose recipient, payout, Memo ID, chain, contract, or
encoded call changed after approval fails with `409 EXECUTION_BINDING_MISMATCH` and never reaches
Circle. Both layers share `server/domain/settlement-binding.js`, so they can never drift.

`AUTONOMOUS_POLICY` is still rejected with `501 EXECUTION_MODE_NOT_ENABLED`, before any claim is
written.

## Crash and unknown-outcome recovery

An atomic claim must not turn duplicate submission into a permanently stuck settlement. The
persisted `executionSubmission` therefore has an explicit lifecycle:

| Status | Holds the claim | Meaning |
|---|---|---|
| `CLAIMED` | Yes | A provider call is in flight, or the process died holding it |
| `UNKNOWN_OUTCOME` | Yes, until the lease expires | The provider may or may not have received the request |
| `SUBMITTED` | No | A provider transaction ID exists |
| `RELEASED` | No | The provider was provably never reached |

Failure classification (`server/domain/execution-claim.js`) decides which applies. A local
configuration error, or a provider rejection carrying HTTP 400/401/403/404/422, provably created
nothing and releases the claim immediately, so a fresh approval may retry at once. Anything
else — a timeout, a 5xx, a dropped connection — is an **unknown outcome** and keeps the claim
until the lease expires. Nothing may retry into that window.

`EXECUTION_CLAIM_LEASE_SECONDS` (default 120, range 30–600) bounds how long a claim survives. An
active claim cannot be stolen before it expires.

> **Extended in Phase 6A.2.2.** A bare lease cannot tell a dead claimant from a slow one, so a
> Circle request outliving its lease could let a second caller in while the first was still alive.
> The claim holder now renews its lease (`EXECUTION_CLAIM_HEARTBEAT_SECONDS`, default 30) for as
> long as its provider call is outstanding. A process that dies stops renewing and its lease
> lapses exactly as described below.

After expiry, a newly authorized operator may resume, and the resumed claim:

- records `resumedFromClaimId` and increments `attempt`
- reuses `providerOperationKey` **verbatim** — it is derived from the settlement ID and is never
  regenerated, so `CircleWalletGateway.executeSettlement` sends Circle the identical idempotency
  key it used before
- appends an `EXECUTION_CLAIM_RESUMED` audit event

If Circle already accepted the original request, the idempotent replay returns that same
transaction, which is then persisted and reconciled. No second payout is created. If a Circle
transaction ID is already recorded, `execute` reconciles and never calls the submission endpoint
at all.

Post-broadcast failures are unchanged: the reservation stays `HELD`, and because a transaction ID
exists, no further claim can create another payout.

### Terminology

This is **at-most-one active provider-call owner while a healthy claimant renews its lease, plus
deterministic provider idempotency and recovery after claimant loss**. It is not, and cannot be,
mathematical exactly-once delivery against a third-party API. The application guarantees one claimant and one deterministic provider
operation identity; Circle's idempotency and MemeVerse's reconciliation together turn that into a
single settled transaction.

## Audit trail

History entries carrying `event: 'EXECUTION'` are audit events rather than state transitions, so
consumers can read the two apart. The trail records `EXECUTION_CLAIMED`, `EXECUTION_CLAIM_RESUMED`,
`EXECUTION_SUBMITTED`, and `EXECUTION_SUBMISSION_FAILED`, each with the claim ID, attempt number,
execution mode, and authorization reference; failures also carry the classification and error
code. The record proves which authorization won, which operator and session stood behind it, when
it was claimed and submitted, and which provider operation identity was used.

Only the opaque authorization *reference* is persisted. Raw authorization tokens, session tokens,
cookies, and wallet signatures never enter the record or the logs.

## APP_ORIGIN canonicalization

`APP_ORIGIN` is compared byte for byte against the browser `Origin` header, so a configured
`https://example.com/` would have failed against `Origin: https://example.com`.
`canonicalizeAppOrigin` now normalizes through `URL.origin` at configuration load and rejects
anything that is not an origin: a non-http(s) scheme, embedded credentials, a query string, a
fragment, or any path other than `/`. The canonical value is used consistently for origin checks,
challenge messages, the CSP `connect-src`, and the CORS response. Exact-origin protection is
unchanged; only the configuration footgun is removed.

## Expired auth record cleanup

`PostgresOperatorAuthStore.purgeExpired` existed but was never scheduled. It now runs:

- once at API startup, best-effort, logged on failure, never blocking the listen
- from the supervised worker on `AUTH_CLEANUP_INTERVAL_SECONDS` (default 3600, range 60–86400)

Deletion is idempotent, so overlapping processes are harmless, and a cleanup failure is logged
without disturbing settlement reconciliation. Records are removed only once they have been
expired for more than a day, which keeps recent expiries available for investigation. Nothing
about a nonce, token, or signature is ever logged.

## Same-origin deployment

Operator sessions use an `HttpOnly`, `SameSite=Strict` cookie, and the browser client sends
`credentials: 'same-origin'`. Production must therefore serve the frontend and the API from one
origin, normally behind a reverse proxy:

```text
https://app-domain.example/            → static frontend build
https://app-domain.example/api/...     → MemeVerse API
```

Set `APP_ORIGIN=https://app-domain.example`, leave `VITE_API_BASE_URL` empty so the browser calls
same-origin paths, and set `TRUSTED_PROXY_HOP_COUNT` to the number of proxies actually in front
of the API. A split-origin deployment would require `SameSite=None`, which weakens CSRF
protection; same-origin remains the supported architecture and is not traded away for
convenience.

## Not changed

No Solidity, no redeployment, no Testnet spend, no live Circle settlement, no autonomous mode, no
NFT or Vault work, no collectors, no UI redesign, and no change to market economics or fees.

# Phase 6A.2.2 — Execution lifecycle finalization

Phase 6A.2.1 made submission pass through one durable, atomic execution claim. A final
end-to-end review found that the claim was correct but the *lifecycle around it* was not: a quote
could invalidate an execution already under way, a lease could lapse under a healthy process, and
a recovery overwrote the record of who originated the payout.

This patch closes those three, plus two smaller correctness items. It changes no contract,
deploys nothing, and spends nothing.

## 1. Quote lifecycle versus execution lifecycle

### The failure

A settlement stays in `AWAITING_SIGNATURE` for the whole time its execution claim is `CLAIMED`
or `UNKNOWN_OUTCOME`, and it still carries the quote's `expiresAt`. The old rule was purely
temporal:

```js
expiresAt && state ∈ {PREPARED, AWAITING_SIGNATURE} && now >= expiresAt   // → EXPIRED
```

So a Circle request that outlived its quote — or an outcome that was never determined — was
transitioned to `EXPIRED`, and the generic reservation rule then moved the treasury reservation
`ACTIVE → RELEASED`. The application freed capacity for a payout Circle may already have
accepted.

It was worse than an accounting error. Reproduced against the pre-patch code, the provider result
could no longer be stored at all:

```text
Cannot transition settlement from EXPIRED to CONFIRMED
Cannot transition settlement from EXPIRED to INITIATED
```

The transaction ID came back from Circle and had nowhere to go. Every path that evaluates expiry
could trigger it: `get()`, `list()`, `releaseExpiredReservations()`, and the sweep that runs
before each new quote.

### The rule

**A settlement may expire only before execution ownership is established.**

`isExecutionCommitted()` (`server/domain/execution-claim.js`) is the hinge. It is deliberately
wider than "holds the claim", because the two questions are different: holding the claim is about
who may call Circle *next*; commitment is about whether Circle may already have accepted a
request.

| Submission status | Holds the claim | Committed | May expire |
|---|---|---|---|
| *(none)* | No | No | Yes, on quote TTL |
| `CLAIMED` | Yes | **Yes** | **Never** |
| `UNKNOWN_OUTCOME` | Yes, until lease expiry | **Yes** | **Never** |
| `SUBMITTED` | No | **Yes** | **Never** |
| `RELEASED` | No | No | Yes, on quote TTL |

A recorded `circle.transactionId` implies commitment on its own, independent of status.

This is a semantic freeze, not a longer timeout. `expiresAt` is never extended, rewritten, or
recomputed; it simply stops being a reason to expire. Moving the deadline further away would only
have moved the race.

### Why `RELEASED` resumes ordinary TTL behaviour

A `RELEASED` submission is one that provably never reached the provider — a local configuration
error, or a provider rejection carrying HTTP 400/401/403/404/422. Nothing exists to protect, so
the quote's own deadline governs again and the capacity is genuinely free. Freezing expiry there
would strand treasury capacity behind an attempt that demonstrably did nothing.

The risk in that choice is a stale TTL releasing capacity while a *newly resumed* claim is live.
It cannot happen: a resumed claim is `CLAIMED`, which is committed, so the settlement is
unexpirable again from the moment the resume commits. The two writers are ordered by the row
version — a sweep that read the record before the claim landed re-reads it under its optimistic
update, sees the claim, and stands down.

### Reservation invariants

| Situation | Reservation |
|---|---|
| `CLAIMED` | `ACTIVE` |
| `UNKNOWN_OUTCOME` | `ACTIVE` |
| Provider transaction exists | `ACTIVE` until terminal reconciliation |
| `COMPLETE` | `CONSUMED` |
| Post-broadcast `FAILED` | `HELD` |
| Pre-provider `RELEASED`, quote still valid | `ACTIVE` |
| Pre-provider `RELEASED`, quote lapsed | `EXPIRED` → `RELEASED` |

The store enforces the same invariant unconditionally rather than relying on the domain to have
got the state right: a terminal state releases capacity only when execution is *not* committed
and nothing was broadcast, otherwise the reservation is `HELD` for investigation. **At no point
may a possibly-accepted provider request coexist with a `RELEASED` reservation.**

Treasury capacity is aggregated in SQL, and that query discounted lapsed quotes purely by
`expiresAt`. It now keeps counting any settlement whose execution is claimed, undetermined, or
submitted, so an in-flight or unresolved payout still consumes capacity however old its quote is.

## 2. Execution claim heartbeat

### The failure

The claim lease exists so a *dead* claimant eventually frees its settlement. It could not tell a
dead process from a slow one:

```text
A claims → A calls Circle → the HTTP request stalls past the lease
                          → the lease expires
                          → B resumes and calls Circle
                          → A's request is still alive
```

Circle's deterministic idempotency key makes a double payout very unlikely, but a provider is not
the application's mutual exclusion, and two live callers for one settlement is not a state the
application should be able to reach on its own.

### The mechanism

While the winning process is waiting on Circle, it renews its own lease. Renewal is a durable,
ownership-conditional write — never an in-memory flag:

```sql
UPDATE settlements
   SET execution_claim_until = $lease,
       record = jsonb_set(record, '{executionSubmission,leaseExpiresAt}', to_jsonb($lease)),
       version = version + 1
 WHERE id = $1
   AND execution_claim_id = $2
   AND circle_transaction_id IS NULL
   AND state = 'AWAITING_SIGNATURE'
RETURNING record, version
```

- Ownership is proven by the database. A process that has lost the claim cannot renew it, and no
  caller can renew a claim it never held.
- Execution authority is never touched, and no history is appended, so a long provider call
  cannot flood the audit trail.
- `version` is bumped so a concurrent writer holding an older snapshot loses its optimistic
  update and reloads, rather than overwriting a fresh lease with a stale one.
- `updated_at` is deliberately left alone: a lease renewal is not a change to the settlement, and
  reconciliation ordering must not be disturbed by it.
- Both the indexed column and the JSON document are updated together, so the claim gate and the
  persisted submission can never disagree about who owns the settlement.

`MemorySettlementStore` and `JsonSettlementStore` implement the identical contract, with the same
outcomes: `RENEWED`, `OWNERSHIP_LOST`, `ALREADY_SUBMITTED`, `NOT_EXECUTABLE`, `NOT_FOUND`.

### Lifecycle

```text
claim execution
      ↓
start lease heartbeat
      ↓
call Circle  ←── renew, renew, renew …
      ↓
stop heartbeat (finally)
      ↓
persist SUBMITTED, or the classified failure
```

The heartbeat stops on provider success, provider error, a lost claim, a persisted transaction
ID, and process shutdown. It always stops *before* the result is persisted.

The crash distinction is the whole point:

- **healthy but slow process** → the lease stays alive, and no second caller can enter
- **dead process** → beats simply stop, the lease lapses on schedule, and recovery proceeds
  exactly as in Phase 6A.2.1

### Failure behaviour

A heartbeat failure is itself uncertainty, so the response is conservative and never expands the
blast radius:

- A transient storage failure is not proof of anything: retry on the next beat, up to three
  consecutive failures.
- If ownership is definitively lost, or a transaction ID now exists, stop treating this process
  as the owner.
- If ownership cannot be proven after repeated failures, stand down and log it.
- In every case, **never start a second provider request**, and never assume the request already
  in flight was cancelled.

If a superseded claimant's provider call does return, its transaction ID is still persisted —
losing it would be far worse than an ambiguous claim — but it does not rewrite the current
attempt's status or authority. That event is recorded as `EXECUTION_SUBMITTED_BY_SUPERSEDED_CLAIM`
and against its own attempt in the trail.

### Configuration

| Variable | Default | Range |
|---|---|---|
| `EXECUTION_CLAIM_LEASE_SECONDS` | 120 | 30–600 |
| `EXECUTION_CLAIM_HEARTBEAT_SECONDS` | 30 | 5–300 |

The heartbeat must be **less than half** the lease, so several beats fit inside one lease and a
single missed beat does not surrender the claim. An unsafe combination is rejected at
configuration load and the process does not start.

## 3. Immutable original authority

### The failure

When authority A won a claim, lost the provider response, and authority B later resumed, the
resumed claim overwrote `executionAuthorization` with B. The root record then attributed the
provider operation to B even though A originated it. History retained A, but the record's own
answer to "who authorized this payout" was wrong.

### The split

```text
executionAuthorization   ← the FIRST authority that ever won a claim. Immutable, forever.
executionSubmission      ← the CURRENT attempt: its own authority, plus initialAuthorizationRef
executionAttempts[]      ← one entry per claim, with its own authority and outcome
```

Every attempt records `attempt`, `claimId`, `executionMode`, `authorizationRef`,
`operatorAddress`, `sessionId`, `claimedAt`, `resumedFromClaimId`, `status`, `submittedAt`,
`failedAt`, `failureClassification`, `failureCode`, and `circleTransactionId`.

| Case | Root authority | Attempt authority |
|---|---|---|
| First execution | A | 1 → A |
| Recovery after unknown outcome | **A** | 1 → A, 2 → B |
| Three attempts | **A** | 1 → A, 2 → B, 3 → C |
| Pre-provider release then retry | **A** | 1 → A, 2 → B |

A pre-provider release keeps the root at A deliberately. The root records the first successfully
claimed execution authority, which gives a stable audit anchor; whether the first attempt reached
the provider is recorded on the attempt, where it belongs.

`providerOperationKey` is derived from the settlement ID and is identical across every attempt,
so recovery can never mint a second provider operation identity or create a second payout.

Only opaque authorization *references* are persisted. Raw authorization tokens, session tokens,
cookies, and wallet signatures never enter the record or the logs.

## 4. Startup schema readiness

A runtime with migrations disabled verified table *existence* only. A database still carrying the
pre-claim `settlements` layout therefore satisfied `to_regclass`, booted cleanly, and failed on
its first write — after a settlement was already in flight.

Readiness now verifies every column the running code reads or writes, via
`information_schema.columns`, against the `requiredColumns` manifest in
`server/repositories/schema.js`. A shortfall stops the process with the missing items named:

```text
Database schema is outdated. Run npm run db:migrate.
Missing: settlements.version, settlements.execution_claim_id, …
```

The check only reads the catalog. It runs no `CREATE`, `ALTER`, `DROP`, or `TRUNCATE`, so the
one-shot migration identity remains the sole DDL-capable identity and the production separation
is intact. This is asserted directly: the readiness path is audited statement by statement in
`server/test/schema-readiness.test.js`.

**Deployment order is unchanged and still matters.** Run
`NODE_ENV=production npm run db:migrate` with the `DATABASE_MIGRATION_URL` identity *before*
rolling out the API and worker. The difference is that a missed migration now fails at startup
instead of mid-settlement.

## 5. Sold-out ticker

`spotPriceUsdc()` returns 0 once the whole fixed supply is sold. The Markets page already routed
through `marketSpotLabel`, but the global marquee formatted the raw price, so a sold-out market
scrolled past as `0 USDC` — reading as a free token. The ticker now uses the same helper:

```text
SYMBOL   SOLD OUT   ONCHAIN
```

Selling stays enabled on every surface; the curve reserve still backs every circulating token.

## Terminology

The correct claim for this system is:

> **At-most-one active provider-call owner while a healthy claimant renews its lease, plus
> deterministic provider idempotency and recovery after claimant loss.**

This is not, and cannot be, mathematically guaranteed exactly-once delivery against a third-party
API. The application guarantees one claim owner and one deterministic provider operation
identity; Circle's idempotency and MemeVerse's reconciliation together turn that into a single
settled transaction.

## Not changed

No Solidity, no redeployment, no Testnet spend, no live Circle settlement, no autonomous
execution, no NFT or Vault work, no collectors, no indexers, no UI redesign, and no change to
market economics or fees. `AUTONOMOUS_POLICY` still fails closed with `501`.

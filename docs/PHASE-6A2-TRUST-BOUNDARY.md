# Phase 6A.2 — Trust boundary and concurrency hardening

Phase 6A.1 made MemeVerse markets a real Arc Public Testnet product. Phase 6A.2 closes the
trust-boundary gaps in the Agent/Settlement backend that stood between that product and any
future autonomous execution.

**What MemeVerse is after this phase:** an Arc Public Testnet product with authenticated
human-controlled Agent settlement and real onchain USDC markets. It is not audited, not mainnet
ready, and not autonomous.

## What changed

| Area | Before 6A.2 | After 6A.2 |
|---|---|---|
| Human approval | A string typed into React (`EXECUTE`) | Wallet-signed operator session plus a one-time, settlement-bound server authorization |
| Privileged routes | Anonymous with a settlement ID | Server-verified operator session required before any business logic |
| Signal provenance | Client chose `MANUAL_DEMO` / `ANALYTICS_PIPELINE` / `ONCHAIN_INDEXER` | Server assigns provenance; the browser can only produce `OPERATOR_INPUT` |
| Evidence timestamp | Client supplied `observedAt` | Server clock for operator input |
| Settlement writes | Last write wins | Optimistic concurrency on `settlements.version` |
| Circle wallet detail | Public | Operator-only; public health reports readiness alone |
| CSP | Disabled | Strict policy on the API and in the production build |
| Rate limits | One global bucket | Global plus per-route-class buckets |
| Proxy trust | Implicit | Explicit `TRUSTED_PROXY_HOP_COUNT` |

## Trust boundaries

There are two completely separate wallet roles. Confusing them is the failure this phase exists
to prevent.

**Public user wallet** — launches meme markets, approves USDC, buys, sells, signs its own
transactions. It needs no MemeVerse account, no session, and no server permission. Nothing in
this phase gates ordinary market activity.

**Platform operator** — the single wallet at `SETTLEMENT_OPERATOR_ADDRESS`. It authenticates the
privileged Agent settlement controls and authorizes Circle treasury settlement in the current
manual mode. Connecting any other wallet grants exactly nothing.

The backend trusts: its own configuration, its own clock, the Arc RPC chain check, Circle's
signed webhooks, and the deployed contracts' events. It does not trust the browser for
provenance, timing, policy, chain, recipient, amount, or authority.

## Public versus privileged routes

| Route | Access |
|---|---|
| `GET /api/health` | Public. High-level readiness booleans only. |
| `GET /api/v1/config` | Public. Network, policy thresholds, capability flags. |
| `GET /api/v1/app-kit/capabilities` | Public. |
| `POST /api/v1/app-kit/swap/estimate` | Public, rate limited. Estimate only; never signs or broadcasts. |
| `POST /api/webhooks/circle` | Authenticated by Circle's `X-Circle-Signature`, not by session. |
| `POST /api/v1/auth/challenge` | Public by design, rate limited. Issues a challenge for any well-formed address so the operator wallet cannot be enumerated. |
| `POST /api/v1/auth/verify` | Public by design, rate limited. Only an operator signature yields a session. |
| `GET /api/v1/auth/session` | Public. Returns sanitized status. |
| `POST /api/v1/auth/logout` | Revokes the presented session. |
| `POST /api/v1/settlements/quote` | **Operator session required.** |
| `POST /api/v1/agent/decisions` | **Operator session required.** |
| `POST /api/v1/settlements/:id/prepare` | **Operator session required.** |
| `POST /api/v1/settlements/:id/execution-authorization` | **Operator session required.** |
| `POST /api/v1/settlements/:id/execute` | **Operator session and a consumed authorization required.** |
| `POST /api/v1/settlements/:id/reconcile` | **Operator session required.** |
| `GET /api/v1/settlements/:id` | **Operator session required.** |
| `GET /api/v1/settlements` | **Operator session required.** |
| `GET /api/v1/circle/wallet` | **Operator session required.** |

Authorization runs as middleware before the handler, so an unauthorized caller receives an
identical `401 OPERATOR_AUTH_REQUIRED` whether or not the settlement ID exists. A session whose
address no longer matches the configured operator receives `403 OPERATOR_FORBIDDEN`.

Every state-changing privileged route and both auth routes additionally require an exact
`Origin` header match. Any request from a foreign `Origin` is rejected with
`403 CROSS_ORIGIN_BLOCKED` before routing. This is CSRF defence in depth alongside the
`SameSite=Strict` cookie; CORS is never used as an authorization mechanism.

## Operator wallet authentication

```
CONNECT WALLET → SIGN OPERATOR SESSION → OPERATOR AUTHENTICATED
      → CREATE / REVIEW SETTLEMENT → FINAL EXECUTION APPROVAL → CIRCLE + ARC
```

`POST /api/v1/auth/challenge` takes `{ address }` and returns a server-generated message. The
message is never supplied by the caller. It binds:

- the MemeVerse identity and the `APP_ORIGIN` host
- the requested wallet address
- Arc chain ID `5042002`
- the scope `SETTLEMENT_OPERATOR_SESSION`
- a 256-bit `crypto.randomBytes` nonce
- the challenge ID, issued-at, and expires-at timestamps

`POST /api/v1/auth/verify` takes `{ challengeId, signature }`. The challenge is **consumed
atomically before the signature is checked**, so a failed, replayed, or expired attempt can never
reuse the nonce. The server then recovers the signer with viem's `recoverMessageAddress` and
requires it to equal both the challenge address and `SETTLEMENT_OPERATOR_ADDRESS`. The address
the browser sent is never trusted after the fact. Unknown challenges, expired challenges, bad
signatures, and non-operator wallets all return the same `401 OPERATOR_AUTH_FAILED`.

`SETTLEMENT_OPERATOR_ADDRESS` must be an exact EIP-55 checksummed address and must not be the
zero address. Production refuses to start when Circle settlement execution credentials are
configured without it.

## Session lifecycle

- 256-bit random token from `crypto.randomBytes`, base64url encoded.
- Only `sha256(token)` is persisted. The raw token is never written to the database or logs.
- Delivered as an `HttpOnly; SameSite=Strict; Path=/` cookie, `Secure` in production.
- Default TTL 20 minutes (`OPERATOR_SESSION_TTL_SECONDS`, 5–60 minutes).
- `GET /api/v1/auth/session` returns only `authenticated`, `operatorAddress`, and `expiresAt`.
- `POST /api/v1/auth/logout` revokes the row and clears the cookie.
- Rotating `SETTLEMENT_OPERATOR_ADDRESS` invalidates every existing session immediately.

## Final settlement authorization

Session authentication alone is **not** sufficient to move funds. Execution requires a second,
separately obtained authorization.

1. `POST /api/v1/settlements/:id/execution-authorization` returns a single-use
   `authorizationId` plus the exact binding the operator is approving. The server stores only
   `sha256(authorizationId)` and `keccak256` of the binding.
2. The binding covers settlement ID, chain ID, recipient, creator payout units, Memo ID,
   settlement contract, Memo contract, and the encoded settlement call-data hash.
3. `POST /api/v1/settlements/:id/execute` takes `{ authorizationId }`. The authorization is
   consumed with a conditional `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()`, so
   exactly one caller can ever win it, and it is burned even when a later check rejects it.
4. The server then requires: the authorization belongs to this settlement, it belongs to the
   current session, and the binding hash still matches the settlement as stored. A changed
   recipient, payout, Memo ID, chain, or contract yields `409 EXECUTION_AUTHORIZATION_STALE`.
5. Default TTL 3 minutes (`OPERATOR_EXECUTION_TTL_SECONDS`).

The resolved authority is persisted on the record as `executionAuthorization` **before** the
Circle call, so the authority behind any broadcast survives a provider error or a crash.

### Superseded by Phase 6A.2.1

Steps 3 to 5 above describe a single-use approval, but a settlement could hold more than one valid
approval at once, so the approval alone was not mutual exclusion. Submission now also passes
through one atomic, database-level execution claim before Circle is contacted, and the winning
authority is immutable. See
[`PHASE-6A21-EXECUTION-CLAIM.md`](./PHASE-6A21-EXECUTION-CLAIM.md).

### Superseded by Phase 6A.2.2

The sentence above — "the resolved authority is persisted as `executionAuthorization` before the
Circle call" — is still true of the *first* claim, but a later recovery used to overwrite that
field. `executionAuthorization` is now the immutable original authority, and each attempt's own
authority is recorded separately in `executionAttempts`. The claim lease is also renewed by
heartbeat while a provider call is alive, and a committed execution can no longer be expired by
its quote TTL. See
[`PHASE-6A22-EXECUTION-LIFECYCLE.md`](./PHASE-6A22-EXECUTION-LIFECYCLE.md).

### Execution modes

`server/domain/execution-mode.js` declares the authorization model explicitly:

- `MANUAL_OPERATOR` — implemented. Requires an operator address and a consumed authorization.
- `AUTONOMOUS_POLICY` — declared, **not enabled**. `SettlementService.execute` rejects it with
  `501 EXECUTION_MODE_NOT_ENABLED`.

There is no hidden bypass flag. `SettlementService.execute(id, authorization)` refuses any call
that does not present a known, enabled mode, so Phase 6B enables autonomy by implementing a mode
rather than by unpicking this phase's checks.

## Provenance model

Provenance is assigned by the server and only by the server.

| Class | Who may assign it | Trusted |
|---|---|---|
| `OPERATOR_INPUT` | The authenticated-operator HTTP route | No |
| `ANALYTICS_PIPELINE` | Internal server code via `decideTrusted` | Yes |
| `ONCHAIN_INDEXER` | Internal server code via `decideTrusted` | Yes |

The HTTP schema for `POST /api/v1/agent/decisions` accepts signal **values** only and is
`.strict()`, so `source`, `provenance`, `observedAt`, and any other unexpected field are rejected
with `400 VALIDATION_ERROR`. A browser therefore cannot claim to be an indexer, cannot claim to
be an analytics pipeline, and cannot backdate or postdate evidence.

`AgentDecisionService.decideOperator` stamps `OPERATOR_INPUT`, binds `observedAt` to the server
clock, and persists the operator address and session ID in the decision evidence.
`AgentDecisionService.decideTrusted` is the internal seam for Phase 6B collectors; it asserts a
trusted provenance class and is not wired to any route. Nothing in this release fabricates an
onchain indexer.

`AGENT_ALLOW_MANUAL_DEMO` and the `MANUAL_DEMO` class are removed outright rather than renamed.
The flaw was trusting a client-asserted source, so the client no longer asserts one.

## Concurrency and versioning

Reservation creation was already serialized. Generic settlement updates were not: a worker and a
webhook could both read state A, and the slower writer could overwrite the faster one's newer
state.

`settlements.version BIGINT NOT NULL` now carries optimistic concurrency:

```sql
UPDATE settlements
   SET ..., version = version + 1
 WHERE id = $1 AND version = $expected
RETURNING record, version
```

A losing writer receives `SETTLEMENT_VERSION_CONFLICT`. `SettlementService.mutate` then reloads
the newest record and **re-evaluates** the mutation against it before retrying. The mutators are
pure functions of the current record, so a stale snapshot is discarded rather than replayed.
Retries only repeat local persistence; no external Circle call is ever retried from this path.
This is a database-level mechanism, not an in-process mutex, so it holds across multiple API and
worker processes. `MemorySettlementStore` and `JsonSettlementStore` implement the same contract.

Evidence merging is monotonic:

- Circle state may only advance; `shouldApplyCircleState` rejects regressions and terminal exits.
- An application state that has reached `COMPLETE` never regresses.
- The transaction hash is preserved when a later snapshot omits it, and a stale snapshot may add
  a hash but never replace one.
- Circle transaction ID, wallet ID, and source address are preserved; a mismatched transaction ID
  raises `502 CIRCLE_TRANSACTION_MISMATCH`.
- `errorReason` / `errorDetails` survive stale success notifications.
- A `VERIFIED` Arc reconciliation is never overwritten by a weaker later result.
- Reservation status still follows state: `CONSUMED` on `COMPLETE`, `HELD` on a post-broadcast
  failure, `RELEASED` on a pre-broadcast terminal state.

`server/test/settlement-concurrency.test.js` covers the deliberate interleavings: a gated worker
write losing to a webhook, `COMPLETE` under stale replays, post-broadcast failure versus stale
success, duplicate and out-of-order notifications, simultaneous workers plus a webhook, hash
preservation, and reservation correctness.

## Circle idempotency strategy

**Rule: an idempotency key must be a function of every input that changes what the call does.**
A stable retry of the identical operation must reuse the key; any changed bytecode, address,
amount, or parameter must produce a different one.

`scripts/circle-idempotency.js` derives a Circle-compatible UUIDv4 from
`sha256(JSON.stringify([scope, ...parts]))`.

| Script | Before | Bound to |
|---|---|---|
| `circle-deploy-settlement.js` | Hard-coded UUID | Artifact bytecode, blockchain, wallet ID, constructor arguments |
| `circle-approve-settlement.js` | Hard-coded UUID | Blockchain, wallet ID, USDC address, spender, exact allowance |
| `circle-setup.js` | Two hard-coded UUIDs | Wallet-set name; blockchain, account type, count, wallet set, ref ID |
| `circle-deploy-market-factory.js` | Already bound (6A.1) | Unchanged |
| `market-e2e-testnet.js` | Already bound (6A.1) | Unchanged |

`CircleWalletGateway.executeSettlement` continues to use the settlement UUID, which is already
unique per settlement and immutable after preparation; a repeat execute deliberately reconciles
the existing Circle transaction instead of creating a second transfer.
`circle-webhook-setup.js` and `circle-fund.js` are left alone: the former lists before creating
and neither SDK call accepts an idempotency key.

## Public API hardening

**Rate limits** (per minute, per client IP, conservative Testnet defaults):

| Class | Limit |
|---|---|
| Global | 240 |
| Auth challenge | 12 |
| Auth verification | 20 |
| Settlement / agent writes | 40 |
| Execution authorization and execute | 15 |
| Circle Stablecoin Kit estimate | 20 |

`X-Forwarded-For` is ignored unless `TRUSTED_PROXY_HOP_COUNT` is greater than zero, in which case
Express is configured with that exact hop count. Blanket `trust proxy: true` is never used, so a
forged header cannot reset a limit.

**Content Security Policy** — `server/security/csp.js` is the single source shared by the Express
API and, through a build-only Vite plugin, the production `index.html`:

```
default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; frame-src 'none';
script-src 'self'; style-src 'self' 'unsafe-inline' https://api.fontshare.com https://fonts.googleapis.com;
img-src 'self' data:; font-src 'self' https://cdn.fontshare.com https://fonts.gstatic.com;
connect-src 'self' https://rpc.testnet.arc.io https://rpc.drpc.testnet.arc.io <APP_ORIGIN>;
form-action 'self'; manifest-src 'self'; worker-src 'self'
```

No wildcard source and no `'unsafe-eval'` appear anywhere. `style-src 'unsafe-inline'` is present
because injected wallet providers and the animation library write style attributes at runtime; no
inline `<script>` is ever permitted. The two font hosts are exactly those `src/styles.css`
imports. Development keeps Vite's own behaviour because the dev server needs an inline module
preamble and an eval-based HMR client.

**Sanitized responses** — `/api/health` reports `circle: { ready }`,
`settlementContract: { configured }`, `appKit: { runtimeEnabled }`, and
`operatorAuth: { configured }`. It no longer publishes the missing-credential inventory or any
Circle wallet identifier. Circle wallet IDs, addresses, and balances now require an operator
session. Provider errors remain sanitized to an operation name and provider status code. Request
logs contain only request ID, method, path, status, and duration — never cookies, wallet
signatures, session tokens, or Circle credentials.

## Sold-out market presentation

`spotPriceUsdc()` returns `0` once the entire fixed supply is circulating, because there is no
next token to price. `src/market-display.js` renders `SOLD OUT` instead of `0 USDC / TOKEN` in
both the market list and the spot quote, and replaces the buy form with an explanation of the
supply and curve reserve. Selling stays available; the curve reserve still backs every
circulating token. **No market contract was changed for this.**

## Same-origin deployment

Operator sessions are `HttpOnly`, `SameSite=Strict` cookies and the browser client sends
`credentials: 'same-origin'`. Production must therefore serve the frontend and the API from one
origin behind a reverse proxy (`https://app-domain.example/` and
`https://app-domain.example/api/...`), with `APP_ORIGIN` set to that bare origin and
`VITE_API_BASE_URL` left empty. A split-origin deployment would require `SameSite=None`, which
weakens CSRF protection and is not supported.

## Remaining Phase 6B work

- Autonomous mode: implement `AUTONOMOUS_POLICY`, including a policy budget, a kill switch, and
  an audit trail distinct from operator approval.
- Real trusted collectors behind `decideTrusted` (`ONCHAIN_INDEXER`, `ANALYTICS_PIPELINE`).
- NFT minting, listing, and ownership; replacement of the labelled Vault simulation.
- Multi-operator support, role separation, and operator rotation procedures.
- An independent professional smart-contract audit before any mainnet consideration.

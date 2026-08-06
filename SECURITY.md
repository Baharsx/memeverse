# Security Policy

MemeVerse is an Arc Public Testnet product with authenticated human-controlled Agent settlement and real onchain USDC markets. Its backend can authorize a Circle Developer-Controlled EOA call through Arc Memo only after server credentials and the verified settlement contract are configured, an authorized operator wallet has authenticated by signature, and that operator has consumed a one-time approval bound to the exact settlement. It is not independently audited, is not mainnet ready, and is not autonomous. It does not accept mainnet assets, provide financial advice, or offer support through unsolicited direct messages.

## User safety

- Verify Arc network information against `https://docs.arc.io/` and network health against `https://status.arc.io/`.
- Confirm Arc Testnet chain ID `5042002` before signing.
- Never share a seed phrase, private key, one-time code, or wallet backup with MemeVerse, Circle, Arc community members, or anyone claiming to provide support.
- Treat unsolicited support messages, token claims, role offers, and requests to install unknown software as hostile.
- Inspect the wallet simulation and destination before signing. A transaction hash is not a receipt until the transaction is confirmed successfully.
- Arc Testnet assets have no real-world value.

## Wallet roles

MemeVerse has two unrelated wallet roles and they must never be conflated.

- **Public user wallet.** Launches meme markets, approves USDC, buys, sells, and signs its own transactions. It requires no session, no server permission, and no operator relationship. Operator authentication must never gate ordinary market activity.
- **Platform operator.** The single wallet configured as `SETTLEMENT_OPERATOR_ADDRESS`. It authenticates the privileged Agent settlement controls and authorizes Circle treasury settlement in the current manual mode. Connecting any other wallet grants no privilege whatsoever.

## Operator authentication and execution authority

- Privileged settlement routes must fail with a stable `401`/`403` before any business logic runs. Settlement enumeration, individual settlement reads, quoting, agent decisions, prepare, execute, reconcile, and Circle wallet detail are all privileged.
- Unauthorized callers must not be able to distinguish an existing settlement ID from a missing one.
- Sign-in is a server-generated challenge binding the MemeVerse identity, `APP_ORIGIN` host, requested address, Arc chain ID `5042002`, scope, a cryptographically random nonce, and explicit issue/expiry times. A caller-supplied message is never accepted.
- The challenge is consumed atomically before signature verification, so a failed, replayed, or expired attempt can never reuse the nonce.
- The signer is derived from the signature and must equal `SETTLEMENT_OPERATOR_ADDRESS`. An address asserted by the browser is never trusted after verification. Non-operator wallets receive a generic unauthorized response.
- `SETTLEMENT_OPERATOR_ADDRESS` must be an exact EIP-55 checksummed non-zero address, must be server-only, and must never use a `VITE_*` prefix. Production must refuse to start when Circle settlement execution credentials are present without it.
- Sessions use a 256-bit random token; only its hash is persisted. The cookie is `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` in production, and short lived. Raw tokens must never reach logs or JSON responses.
- Authentication alone must never be sufficient to move funds. Execution additionally requires a one-time, expiring authorization bound to settlement ID, chain ID, recipient, creator payout units, Memo ID, settlement contract, Memo contract, and settlement call-data hash. It is consumed atomically, cannot be replayed, cannot execute another settlement, and is invalidated by any change to that payload.
- A settlement may have more than one valid authorization outstanding, so a single-use approval is not by itself mutual exclusion. Submission must pass through one durable, database-level execution claim: an atomic conditional update requiring the expected row version, `AWAITING_SIGNATURE`, no provider transaction, and no unexpired claim. Only the winner may contact the provider.
- The claim must be committed before the external call, and the external call must never run inside a database transaction. A losing caller must receive a stable `409` and must never reach the provider.
- The winning execution authority is immutable. Operator address, session, authorization reference, binding hash, and execution mode must never be overwritten by a later approval, and last-write-wins on execution authority is forbidden.
- The approval binding must be re-checked against the live settlement inside the claim, not only when the authorization is consumed.
- Provider idempotency is defence in depth, never the primary lock. Application mutual exclusion must not depend on provider behaviour.
- The resolved execution authority is persisted on the record before the provider call so the authority behind any broadcast survives a failure.
- An execution claim must carry a short, bounded lease and must not be stealable before it expires. After expiry, a newly authorized operator may resume only by reusing the same deterministic provider operation identity; a new identity must never be generated for a resume.
- A quote's expiry governs only when execution may begin. Once execution is committed — claimed, undetermined, or submitted — expiry must never invalidate the settlement and must never release its treasury reservation, because the provider may already have accepted the payout. A possibly-accepted provider request and a `RELEASED` reservation must never coexist. Expiry may resume only for a submission that provably never reached the provider. The freeze must be semantic; extending the deadline merely moves the race.
- A lease must distinguish a slow claimant from a dead one. While a provider call is outstanding, the claim holder must renew its lease through a durable, ownership-conditional write that proves ownership in the database, never from an in-memory flag; a process that has lost the claim must be unable to renew it. Renewal must not rewrite execution authority and must not append history. A claimant that stops renewing must remain recoverable exactly as before once its lease lapses. The heartbeat interval must be materially shorter than the lease, and an unsafe combination must be rejected at configuration load.
- A heartbeat failure is itself uncertainty and must never widen the blast radius. A transient failure may be retried a bounded number of times; unprovable ownership must stand down. A second provider request must never be created because a renewal failed, and a request already in flight must never be assumed cancelled. If a superseded claimant's call does return, its transaction ID must still be persisted, without rewriting the current attempt.
- The first authority ever to win a claim must remain the settlement's execution authority for its entire lifetime. A recovery must never overwrite it; every recovery authorization must be separately recorded with its attempt number, claim ID, operator, session reference, and outcome, so the trail shows both who originated the provider operation and who approved each retry.
- A runtime that is forbidden from running DDL must verify every table and every column it writes before serving traffic, and must fail startup with a clear, actionable message naming what is missing. Verifying table existence alone is insufficient: an outdated layout would otherwise boot and fail on the first settlement write. The readiness check must read the catalog only and must never mutate schema.
- Provider failures must be classified. A failure that provably never reached the provider releases the claim; any undetermined outcome keeps the claim until the lease expires so nothing retries into that window. Local persistence retries and external provider retries must remain separate, and the generic concurrency retry loop must never re-invoke the provider.
- Once a provider transaction ID exists, execution must reconcile rather than submit again.
- The audit trail must record which authorization won, the operator and session behind it, the claim identifier and attempt, the provider operation identity, submission time, and any failure classification. It must never contain raw authorization tokens, session tokens, cookies, or wallet signatures.
- Execution authority is explicit and persisted. `MANUAL_OPERATOR` is the only enabled mode; `AUTONOMOUS_POLICY` is declared and fails closed. There is no hidden bypass flag.
- Auth routes and every privileged mutation require an exact `Origin` match, and any foreign `Origin` is rejected before routing. CORS is never an authorization mechanism, and a client-side confirmation string is never a security control.
- `APP_ORIGIN` is compared byte for byte with the browser `Origin` header and must be canonicalized to a bare `scheme://host[:port]`. A path, query, fragment, embedded credential, or non-http(s) scheme must be rejected at configuration load rather than silently breaking every privileged request.
- Operator sessions use an `HttpOnly`, `SameSite=Strict` cookie with same-origin credentials, so production must serve the frontend and the API from one origin behind a reverse proxy. Switching to `SameSite=None` to enable a split-origin deployment is not an acceptable trade.
- Expired challenges, sessions, and execution approvals must be swept on a schedule. Deletion must be idempotent and safe across processes, and a cleanup failure must be logged without disturbing settlement reconciliation.

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
- Signal provenance is assigned by the server and never by an HTTP client. Clients may submit signal values only; the request schema must reject `source`, `provenance`, `observedAt`, and any other unexpected field.
- The browser can only produce `OPERATOR_INPUT`, and only through an authenticated operator session. `ONCHAIN_INDEXER` and `ANALYTICS_PIPELINE` are reserved for internal server collectors and must not be fabricated.
- Operator-supplied evidence is timestamped by the server clock, and the operator address and session are persisted in the decision evidence.
- Settlement mutations must use database-level optimistic concurrency on a row version. A losing writer must reload and re-evaluate rather than overwrite. An in-process mutex is not sufficient because production runs multiple processes.
- Advanced Circle state, `COMPLETE`, transaction hashes, Circle transaction IDs, provider failure details, and verified Arc reconciliation must never be erased by a stale worker or webhook write. Concurrency retries apply to local persistence only and must never replay an external Circle execution.
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
- Every Circle idempotency key must be derived from the full set of inputs that determine the call: operation, blockchain, wallet, artifact bytecode, constructor arguments, contract address, amount, and recipient. A stable retry reuses the key; any changed parameter must produce a different one. Idempotency must not be added to an SDK call that does not accept it.
- Rate limits must exist per route class, not only globally. `X-Forwarded-For` must be ignored unless an explicit trusted proxy hop count is configured; blanket proxy trust is forbidden.
- Production must serve a Content Security Policy with no wildcard source and no `'unsafe-eval'`, covering both the API and the built browser document.
- Public responses must never expose Circle API keys, entity secrets, Kit Keys, session tokens, challenge secrets, database or migration URLs, internal wallet identifiers, raw provider errors, authorization cookies, or stack traces. Logs must never contain cookies, wallet signatures, session tokens, or Circle credentials.
- A market whose entire fixed supply is sold must be presented as sold out rather than as a zero price, on every surface that prices a market. Buying is disabled; selling against the curve reserve remains available.

The Phase 4 threat model, residual risks, and onchain read-only checks are documented in [`docs/PHASE-4-SECURITY-REVIEW.md`](./docs/PHASE-4-SECURITY-REVIEW.md). The Phase 6A.2 trust boundaries, operator authentication, execution authorization, provenance model, and concurrency design are documented in [`docs/PHASE-6A2-TRUST-BOUNDARY.md`](./docs/PHASE-6A2-TRUST-BOUNDARY.md). The Phase 6A.2.1 atomic execution claim, crash recovery, and same-origin deployment requirement are documented in [`docs/PHASE-6A21-EXECUTION-CLAIM.md`](./docs/PHASE-6A21-EXECUTION-CLAIM.md). The Phase 6A.2.2 quote-versus-execution lifecycle split, claim lease heartbeat, immutable original authority, and startup schema readiness are documented in [`docs/PHASE-6A22-EXECUTION-LIFECYCLE.md`](./docs/PHASE-6A22-EXECUTION-LIFECYCLE.md).

MemeVerse claims **at-most-one active provider-call owner while a healthy claimant renews its lease, plus deterministic provider idempotency and recovery after claimant loss**. It does not claim mathematically guaranteed exactly-once delivery against a third-party API, which is not achievable.

## Reporting a vulnerability

Do not publish exploitable details, credentials, wallet data, or user information in a public issue. Contact the repository owner through the verified GitHub account and include minimal reproduction steps without secrets.

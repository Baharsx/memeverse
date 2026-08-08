# MemeVerse

## A meme becomes an economy.

MemeVerse turns a meme into a real Arc market. People trade it in USDC, the creator earns from
every trade and keeps onchain provenance of their media — and **an autonomous agent reads the real
trading record and pays that creator from a Circle Agent Wallet, with no human approving the
payment.**

Every step resolves to an Arc transaction anyone can verify.

```
CREATE → TRADE → OWN → REWARD → PROVE
```

**Live proof, right now, on Arc Public Testnet:** an autonomous creator payout of **0.100000 USDC**,
executed by Circle Agent Wallet [`0x65da73c6…0FE3`](https://testnet.arcscan.app/address/0x65da73c6d9300F3dAb1dF785219f76DeCA5e0FE3),
reconciled **VERIFIED**, `operatorAddress: null`, human authorization consumed: **no** —
[`0xffad62e6…6b6799`](https://testnet.arcscan.app/tx/0xffad62e616262a682dcfd0ac85a7ced9f7b16290b29beadec6225e008c6b6799).

## ▶ Live demo: **<https://memeverse.biz>**

| | |
| --- | --- |
| **Primary track** | Agentic |
| **Supporting track** | DeFi |
| **Network** | Arc Public Testnet (chain `5042002`) |
| **Settlement asset & gas** | USDC |

### Judge in 60 seconds

1. Open **<https://memeverse.biz>** — the five-step economy and live runtime checks are on the homepage
2. **[/markets](https://memeverse.biz/markets)** — real factory-deployed USDC markets, live curve state
3. **[/agent](https://memeverse.biz/agent)** — the autonomous agent: Circle Agent Wallet, budget, policy, decisions
4. **[/safety](https://memeverse.biz/safety)** — every deployed contract, both execution modes, the limits
5. Open any ArcScan link and verify the payout yourself — no need to trust this page

### Start here

| If you want to… | Go to |
| --- | --- |
| **Use the live product** | **<https://memeverse.biz>** |
| Watch the autonomous agent | <https://memeverse.biz/agent> |
| Verify contracts and proofs | <https://memeverse.biz/safety> |
| See the Circle Stablecoin Kits quote | <https://memeverse.biz/quote> |
| Read the submission copy, contracts, proofs, and judge Q&A | [`docs/SUBMISSION.md`](./docs/SUBMISSION.md) |
| See the 3-minute demo, click by click, with fallbacks | [`docs/DEMO-SCRIPT.md`](./docs/DEMO-SCRIPT.md) |
| Prepare a live presentation | [`docs/DEMO-CHECKLIST.md`](./docs/DEMO-CHECKLIST.md) |
| Understand what Stage 3 changed and why it is safe | [`docs/STAGE-3-FINAL.md`](./docs/STAGE-3-FINAL.md) |
| Read the full autonomous trust boundary | [`docs/PHASE-6B-STAGE-2.md`](./docs/PHASE-6B-STAGE-2.md) |
| Check readiness before a demo | `npm run demo:preflight` |

### Architecture in six lines

```
Browser (React 19 / Vite)     reads Arc contracts directly; only VITE_* values ever reach it
      │
Express 5 API                 sanitized status, operator auth, App Kit estimates
      │
Autonomous worker (separate)  Arc log collector → deterministic policy → spend admission → payout
      │
PostgreSQL                    epoch claims, spend reservations, settlement audit trail
      │
Circle Agent Wallet (ERC-4337, MPC)   signs autonomous payouts — no private key in this repo
      │
Arc Public Testnet            markets, media NFT, marketplace, vault, two settlement contracts
```

### Why Arc, and why Circle

**Arc** because USDC is native money *and* native gas. A bounded autonomous spend policy — at most
0.1 USDC per payout, 0.3 per market per day — is only expressible when the agent's budget, its
payouts, and its transaction costs are the same unit of account. A separate volatile gas token
would require a second treasury and a price feed before the agent could make one bounded decision.

**Circle** because the executor is a real **Agent Wallet**: an ERC-4337 smart account backed by
2-of-2 MPC, created with the official CLI. No private key exists in this codebase. The separate
human-authorized route uses a **Developer-Controlled Wallet**; every contract was deployed through
the **Smart Contract Platform**; `/quote` uses **Stablecoin Kits** for live estimates.

### Verify it yourself

```bash
npm ci
npm run demo:preflight        # read-only: RPC, chain ID, every contract's bytecode, proof txs
npm run contracts:audit:onchain
npm run markets:audit:onchain
npm run assets:audit:onchain
NODE_ENV=test npm test        # 302 backend + 54 contract = 356
NODE_ENV=production npm run build
npm audit
```

None of those write to the chain.

---

**MemeVerse is an Arc Public Testnet product. It is not independently audited and is not mainnet
ready.** Test assets have no real-world value.

---

The current release is an Arc Public Testnet product. Markets, balances, quotes, positions, fees, and receipts come from deployed contracts and the Arc RPC; no market financial data is fabricated.

**Backend (Stage 2, Phase 6B):** real Arc media NFTs with onchain market provenance, a real USDC NFT marketplace, a real ERC-4626 USDC vault, and a genuinely autonomous creator-settlement agent that reads confirmed Arc evidence, decides by deterministic policy, and pays creators in USDC with no human approval in the execution path. All three contracts are deployed and verified on Arc Testnet, and each has been proven with live transactions — including one real autonomous payout. See [`docs/PHASE-6B-STAGE-2.md`](./docs/PHASE-6B-STAGE-2.md) for addresses, transaction hashes, and the full trust boundary.

**Browser UI:** the NFT, marketplace, vault, and agent surfaces all read deployed Arc contracts and the sanitized backend status. No simulated market, NFT, or vault data exists anywhere in the product. The manual operator settlement path is unchanged and still requires a wallet-signed session plus a one-time approval bound to the exact settlement; on `/agent` it is presented as a collapsed secondary route so it cannot be mistaken for the autonomous one.

**Circle Agent Stack is integrated.** Autonomous payouts execute through a Circle **Agent Wallet** (`0x65da73c6d9300F3dAb1dF785219f76DeCA5e0FE3`), created with the official `@circle-fin/cli` on Arc Testnet. Because an Agent Wallet is an ERC-4337 smart contract account, and Arc's Memo `CallFrom` only preserves a directly signing EOA, the autonomous route calls its own settlement contract directly while the manual operator route keeps the Developer-Controlled Wallet and the Memo hop. The two routes share no wallet, contract, or allowance. Circle's wallet-level spending policies are mainnet-only, so on testnet every cap is application-level — see [`docs/PHASE-6B-STAGE-2.md`](./docs/PHASE-6B-STAGE-2.md).


## Built on Arc

MemeVerse is an independent product. The MemeVerse name and visual identity lead; Arc is the stablecoin infrastructure underneath it.

The product explores two Arc ecosystem tracks:

- **DeFi:** USDC-denominated meme markets, bonding curves, treasury controls, creator revenue splits, and conditional settlement.
- **Agentic economy:** an autonomous worker that discovers registered markets, reads confirmed Arc trading evidence, scores it with deterministic policy, and executes bounded creator payouts from a Circle Agent Wallet with no per-payout human approval — each one reconciled back against Arc.

## Current MVP

Everything below is implemented and running against Arc Public Testnet. Grouped so the shape is
readable; the detailed mechanics are in the sections further down and in `docs/`.

**Meme markets (DeFi)** — wallet-signed token + bonding-market deployment through
`MemeVerseFactory`; factory-discovered markets with live supply, price, reserve, and position;
real USDC approve/buy/sell with minimum-output slippage protection; 1% creator + 1% treasury
allocation settled inside the same trade; exact six-decimal integer math throughout.

**Creator ownership** — media NFTs whose mint path verifies factory-registered market provenance
onchain and de-duplicates the creator's content commitment; a zero-fee USDC marketplace that
refuses to fill a listing whose seller no longer owns or approves the token; an ERC-4626 USDC
vault as a composable treasury primitive (no strategy, `annualPercentageYieldBps()` returns zero).

**Autonomous creator rewards (Agentic)** — a separately supervised worker discovers registered
markets, derives signals from confirmed Arc trades, scores them with a versioned deterministic
policy, derives the recipient from `market.creator()` and the amount from the score, and pays from
a Circle **Agent Wallet** with **no per-payout human approval**. Every payout is reconciled against
`SettlementExecuted` and the USDC `Transfer` before it is reported as verified.

**Spend safety** — transactional global and per-market daily caps admitted inside one PostgreSQL
transaction under an exclusive lock; one payout per market per policy epoch enforced by a primary
key; capacity held (never released) on an undetermined provider outcome; one durable execution
claim per settlement with heartbeat-renewed leases; deterministic provider idempotency keys.

**Manual operator route (isolated)** — wallet-signed operator sessions with one-time expiring
challenges, settlement-bound single-use execution approvals, explicit
`quote → prepare → execute → reconcile` with no automatic or hidden signing, Developer-Controlled
Wallet execution through Arc Memo `CallFrom`. Shares no wallet, contract, or allowance with the
autonomous route.

**Platform** — Express 5 API with Arc chain verification and structured errors; durable PostgreSQL
persistence with optimistic concurrency and startup schema verification; signed Circle webhook
verification with replay protection; route-class rate limits, strict CSP, and explicit proxy trust;
fail-closed Circle Stablecoin Kits quote boundary with server-only Kit Key; ArcScan links shown
only after a real hash or final receipt exists; responsive tactile-brutalist interface.

## Arc Testnet configuration

MemeVerse uses only parameters currently published in the official Arc documentation. No mainnet RPC, chain ID, or contract address will be added until Arc publishes it through official documentation.

| Property | Value |
|---|---|
| Chain ID | `5042002` |
| Native gas | USDC |
| RPC | `https://rpc.testnet.arc.io` |
| Documented fallback RPC | `https://rpc.drpc.testnet.arc.io` |
| WebSocket | `wss://rpc.testnet.arc.io` |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com/` |
| Finality handling | 1 confirmed block |

The public RPC can be overridden for local development:

```bash
cp .env.example .env.local
```

Only public browser configuration may use a `VITE_*` variable. Never place private keys or privileged Circle credentials in a Vite environment variable.

## Verified Testnet contracts

| Contract | Address | Purpose |
|---|---|---|
| USDC ERC-20 interface | `0x3600000000000000000000000000000000000000` | Six-decimal USDC transfers and allowances |
| Memo | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` | Reconciliation metadata around a contract call |
| Multicall3From | `0x522fAf9A91c41c443c66765030741e4AaCe147D0` | Batched calls with original EOA sender preservation |

MemeVerse owns and operates this application contract; it is not an Arc or Circle system contract:

| Contract | Address | Verification |
|---|---|---|
| MemeVerseSettlement | [`0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7`](https://testnet.arcscan.app/address/0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7) | Fully verified source on ArcScan; Solidity 0.8.30, Cancun, optimizer 200 |
| MemeVerseFactory 6A.1 | [`0x363124490E953EEbB414eB4c3e2f03a40eef8F2C`](https://testnet.arcscan.app/address/0x363124490E953EEbB414eB4c3e2f03a40eef8F2C) | Fully verified exact-spend registry/factory; Solidity 0.8.30, Cancun, via-IR, optimizer 200 |
| MMV6A1 MemeMarket | [`0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D`](https://testnet.arcscan.app/address/0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D) | Fully verified exact-spend seed market and ERC-20 asset |

Addresses must be rechecked against the [official Arc contract registry](https://docs.arc.io/arc/references/contract-addresses) before deployment.

The Phase 6A factory [`0x765E2Eaa…8c08F`](https://testnet.arcscan.app/address/0x765E2Eaaba8eaEF4437B15CF42C1F268D3c8c08F) and market [`0x5CcB34ec…8880D`](https://testnet.arcscan.app/address/0x5CcB34ec32e5ea12CdD7119157De9b8207b8880D) are immutable legacy Testnet contracts. Their buy path transferred the complete maximum input and could retain a material unused budget. The application no longer discovers or submits transactions to them.

## Architecture

```text
Connected wallet → MemeVerseFactory → MemeMarket / ERC-20 asset
                                          ↕
                              Arc Testnet USDC ERC-20
                                          ↓
                               Creator + treasury fees
```

The factory has immutable USDC, treasury, and fee configuration and no admin mutation surface. A market holds its unsold fixed supply, tracks whole-token circulating supply, retains the exact curve reserve, and transfers fees immediately. The chain is authoritative; the current scale does not require a financial-state database indexer.

### Pricing and rounding

For total whole-token supply `T`, base price `b`, curve increment `m`, and sold token count `q`, cumulative cost in six-decimal USDC units is:

```text
C(q) = bq + floor(mq(q - 1) / (2(T - 1)))
```

A buy treats the user's input as a maximum budget. Binary search returns the largest whole-token output whose executed curve cost plus creator and treasury fees fits that maximum. Both buy fees are derived from actual curve cost, and the contract transfers only `actualUsdcSpent = curveCost + creatorFee + treasuryFee`; unused maximum budget never leaves the wallet. Approval may cover the maximum. A sell returns `C(q) - C(q - amount)` before fees derived from that same executed curve value. Fee division and the curve term round down; each fee's rounding error is strictly less than one six-decimal USDC atomic unit. Users set maximum USDC input plus minimum token output on buys, and exact whole-token input plus minimum USDC output on sells. The UI defaults to 1% slippage.

This deliberately simple Testnet curve is not capital efficient, does not provide external liquidity, trades only whole tokens, and has not received an independent audit. It must not be deployed to mainnet.

### Agent settlement architecture

```text
Agent form → Settlement API → Policy + treasury reservation
                    ↓                     ↓
       PostgreSQL transaction       Circle EOA signer
                    ↓                     ↓
             State machine ← Arc Memo → MemeVerseSettlement
                    ↑                     ↓
        Poll / signed webhook   Memo + settlement + USDC events
                    ↑                     ↓
        Separately supervised leased worker / Arc indexer
```

The backend remains the authority for signal weighting, policy, recipient, amount, chain, expiry, daily cap, and allowed state transitions. Circle credentials, the entity secret, and any future Kit Key never enter the Vite bundle. The Circle SDK produces a unique entity-secret ciphertext for each authorized request and Circle receives the settlement UUID as its idempotency key.

### Settlement API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | Verify API availability, Arc Chain ID, and current block |
| `GET` | `/api/v1/config` | Return public network and policy settings |
| `POST` | `/api/v1/auth/challenge` | Issue a one-time, expiring operator sign-in challenge |
| `POST` | `/api/v1/auth/verify` | Verify the wallet signature and open an operator session |
| `GET` | `/api/v1/auth/session` | Report sanitized operator session status |
| `POST` | `/api/v1/auth/logout` | Revoke the presented operator session |
| `POST` | `/api/v1/settlements/quote` | **Operator.** Enforce policy and persist an approved or denied decision |
| `POST` | `/api/v1/agent/decisions` | **Operator.** Weight signals, capture operational evidence, quote, and conditionally prepare |
| `POST` | `/api/v1/settlements/:id/prepare` | **Operator.** Move an approved live quote to `AWAITING_SIGNATURE` |
| `POST` | `/api/v1/settlements/:id/execution-authorization` | **Operator.** Issue a single-use approval bound to this settlement |
| `POST` | `/api/v1/settlements/:id/execute` | **Operator + approval.** Submit the Arc Memo contract call to Circle |
| `POST` | `/api/v1/settlements/:id/reconcile` | **Operator.** Compare Circle state with the final Arc receipt and expected events |
| `GET` | `/api/v1/settlements/:id` | **Operator.** Read one settlement and lazily apply expiry |
| `GET` | `/api/v1/settlements` | **Operator.** List persisted settlements |
| `GET` | `/api/v1/circle/wallet` | **Operator.** Check configured EOA state and Arc Testnet USDC balance |
| `GET` | `/api/v1/app-kit/capabilities` | Report the server-side Circle Stablecoin Kits capability boundary and runtime audit status |
| `POST` | `/api/v1/app-kit/swap/estimate` | Return a sanitized Circle Stablecoin Kits swap estimate; fail closed without the server Kit Key |
| `POST` | `/api/webhooks/circle` | Verify and consume signed `transactions.outbound` notifications |

Routes marked **Operator** require a server-verified operator session and fail with `401` before any business logic, so an unauthorized caller cannot learn whether a settlement ID exists. Auth routes and every privileged mutation also require an exact `Origin` match. `POST /quote` requires an `Idempotency-Key` header between 8 and 128 characters. Reusing the same key and body returns the original record; reusing it with a different body returns HTTP `409`.

### Operator authentication

Privileged Agent settlement is controlled by one wallet, configured server-side as
`SETTLEMENT_OPERATOR_ADDRESS`. It is entirely separate from the public wallets that launch and
trade markets: connecting an ordinary wallet grants no privilege, and operator authentication
never gates market activity.

```text
CONNECT WALLET → SIGN OPERATOR SESSION → OPERATOR AUTHENTICATED
      → CREATE / REVIEW SETTLEMENT → FINAL EXECUTION APPROVAL → CIRCLE + ARC
```

The server issues a challenge binding the MemeVerse identity, `APP_ORIGIN` host, requested
address, Arc chain ID `5042002`, scope, a random nonce, and explicit issue/expiry times. The
challenge is consumed before the signature is checked, the signer is recovered from the
signature, and only `SETTLEMENT_OPERATOR_ADDRESS` receives a session. Sessions are short-lived
`HttpOnly`, `SameSite=Strict` cookies whose tokens are stored only as hashes.

Execution then needs a second proof. `POST /:id/execution-authorization` returns a single-use,
expiring approval bound to the settlement ID, chain, recipient, creator payout units, Memo ID,
settlement contract, and encoded call-data hash. It is consumed atomically, cannot be replayed,
cannot execute a different settlement, and is invalidated by any change to that payload.

Both execution modes are implemented and physically isolated. `MANUAL_OPERATOR` executes from the
Circle Developer-Controlled Wallet through the Arc Memo route, and requires an authenticated human
operator session plus that settlement-bound execution authorization. `AUTONOMOUS_POLICY` executes
from the Circle Agent Wallet through a separate autonomous settlement contract, is only reachable
with an authority minted in-process — a request body naming the mode is rejected — and has no
fallback to the manual Developer-Controlled Wallet.

Because a settlement can have more than one valid approval outstanding, submission also passes
through a single durable execution claim: an atomic conditional update that requires the expected
row version, `AWAITING_SIGNATURE`, no provider transaction, and no unexpired claim. Exactly one
caller wins and contacts Circle; every other caller receives `409 EXECUTION_ALREADY_CLAIMED` or
reconciles an already-known transaction, and the winner's authority can never be overwritten. A
short claim lease (`EXECUTION_CLAIM_LEASE_SECONDS`) allows a crashed or undetermined attempt to be
resumed later using the same deterministic Circle idempotency identity, so recovery never creates a
second payout.

The quote lifecycle and the execution lifecycle are deliberately separate. A quote's `expiresAt`
bounds only when execution may *begin*: once a claim is won, the settlement can no longer expire,
because expiry releases the treasury reservation and Circle may already have accepted the payout.
While the winning process waits on Circle it renews its own lease
(`EXECUTION_CLAIM_HEARTBEAT_SECONDS`) through an ownership-conditional database write, so a slow
provider call is never mistaken for a dead process — and a process that dies simply stops renewing,
letting its lease lapse on schedule. The first authority ever to win a claim is recorded
permanently as the settlement's execution authority; every later recovery is audited as its own
attempt rather than overwriting it. Full details are in
[`docs/PHASE-6A2-TRUST-BOUNDARY.md`](./docs/PHASE-6A2-TRUST-BOUNDARY.md),
[`docs/PHASE-6A21-EXECUTION-CLAIM.md`](./docs/PHASE-6A21-EXECUTION-CLAIM.md), and
[`docs/PHASE-6A22-EXECUTION-LIFECYCLE.md`](./docs/PHASE-6A22-EXECUTION-LIFECYCLE.md).

## Transaction and reconciliation model

The settlement backend recognizes these application states:

1. `PREPARED` or `DENIED`
2. `AWAITING_SIGNATURE`
3. Circle-compatible asynchronous states: `INITIATED`, `CLEARED`, `QUEUED`, `SENT`, `STUCK`
4. `CONFIRMED`, then `COMPLETE`
5. Terminal recovery states: `EXPIRED`, `CANCELLED`, `FAILED`

The application persists the client reference, Memo ID, exact inner calldata, calldata hash, latest transaction hash, chain ID, expected contract, and failure class. A hash alone is not proof of success. Circle `COMPLETE` maps only to application `CONFIRMED`; application `COMPLETE` requires a successful Arc receipt plus the expected Memo, SettlementExecuted, and USDC Transfer events.

Blind retries are forbidden. A pre-broadcast rejection may be safely retried after user action. An unknown or post-broadcast failure must first be reconciled by transaction hash and reference to avoid duplicate execution.

### Transaction Memo guardrails

- Memo is used only by the manual operator settlement flow; the autonomous Agent Wallet route calls its settlement contract directly because Arc's Memo `CallFrom` does not accept a smart contract account. Market launch/trading is directly wallet-signed onchain. NFT, marketplace, and Vault surfaces read deployed Arc contracts. The Circle Stablecoin Kits screen returns a live estimate but never prepares or broadcasts its transaction.
- The direct caller must be an externally owned account (EOA).
- Smart contract accounts, ERC-4337 wallets, Safe, and intermediary contracts are not supported as direct callers.
- Memo events are indexed by `memoId`, sender, and target; the original calldata should be retained when exact call reconstruction is required.
- Memo formats and indexer queries must be tested end to end before production use.

### Batched transaction guardrails

- Multicall3From also requires a direct EOA caller.
- `allowFailure` must be selected deliberately for each call.
- Atomic financial operations use `allowFailure: false`; partial execution is allowed only when the product explicitly reconciles each failed subcall.
- Success is verified from the target contract events because Multicall3From does not emit a batch-specific success event.

## Circle wallet integration

MemeVerse uses `@circle-fin/developer-controlled-wallets` with an Arc Testnet EOA. EOA is deliberate because Arc Transaction Memo currently requires a direct EOA caller. Circle spending policies are not currently available on Testnet, so MemeVerse continues to enforce its own server policy before invoking Circle.

Implemented safeguards:

- Circle calls are unavailable unless API key, entity secret, and wallet ID are all present server-side.
- Every execution is fixed to `ARC-TESTNET`, the official Memo contract, the verified MemeVerseSettlement contract, and the Arc USDC address.
- The inner `settle(bytes32,address,uint256)` calldata and its hash are persisted before signing.
- The onchain contract accepts only the configured Circle EOA and rejects duplicate settlement IDs.
- A repeated execute call reconciles the existing Circle transaction instead of creating a second transfer.
- Submitted, broadcast, confirmed, and complete remain distinct states.
- Webhook signatures are checked against Circle's rotating `X-Circle-Key-Id` public key.
- Notification IDs are persisted before another notification with the same ID can be applied.
- Older, out-of-order success notifications cannot regress an advanced settlement state.

## Transactional persistence and reservations

The default local database is PGlite, a durable embedded PostgreSQL engine stored under `.data/postgres`. Production can use managed PostgreSQL by setting `DATABASE_URL`. Settlement records, idempotency keys, Circle transaction IDs, and reservation status are committed transactionally.

Before an approved quote is persisted, active reservations are summed under a serialized PostgreSQL transaction. A quote fails with `TREASURY_CAPACITY_EXCEEDED` when its payout would exceed the current Circle USDC balance after active reservations. Agent decisions also sum the current UTC day's active, held, and consumed agent payouts and fail with `AGENT_DAILY_CAP_EXCEEDED` above the configured cap. Expiry, denial, cancellation, or a pre-broadcast failure releases capacity; independently verified completion consumes it. A failed or mismatched post-broadcast transaction becomes `HELD` and continues consuming capacity until manual resolution.

Circle webhook receipts are deduplicated in PostgreSQL. The old JSON notification file is imported once when the database is empty. Continuous reconciliation runs in `server/worker.js`, not inside the HTTP process. Workers atomically claim records with `FOR UPDATE SKIP LOCKED` and an expiring lease, so multiple supervised instances do not process the same record concurrently.

Every settlement update carries an optimistic-concurrency version. A write only lands when the
row still holds the version its author read; a losing writer reloads the newest record and
re-evaluates the mutation instead of overwriting it. This is a database-level mechanism, so it
holds across multiple API and worker processes. Circle state may only advance, `COMPLETE` never
regresses, and transaction hashes, Circle transaction IDs, provider failure details, and verified
Arc reconciliation cannot be erased by a stale worker or webhook. Concurrency retries repeat only
local persistence and never replay an external Circle call.

Operator sign-in challenges, sessions, and execution approvals are stored in the same database as
`operator_auth_challenges`, `operator_sessions`, and `operator_execution_authorizations`, so
single-use enforcement is durable and multi-process safe. They are created by the same
`RUN_DATABASE_MIGRATIONS` / `DATABASE_MIGRATION_URL` one-shot migration path as the rest of the
schema. Long-expired rows are swept best-effort at API startup and then by the supervised worker
on `AUTH_CLEANUP_INTERVAL_SECONDS`; deletion is idempotent and a cleanup failure never disturbs
settlement reconciliation.

## Agent Policy V2

The current weighted score is deterministic:

```text
raw score = 45% engagement velocity + 25% holder retention + 30% liquidity depth
adjusted score = floor(raw score × confidence / 100)
```

Evidence older than five minutes, confidence below 80, fraud risk above 20, an unverified Arc RPC, or a non-live Circle wallet fails closed. Each record persists the provenance, evidence age, weighted score, live Arc block, Circle wallet state, treasury balance, applied thresholds, and denial reasons.

Signal provenance is assigned by the server and never by the browser. The HTTP schema accepts
signal values only and rejects `source`, `provenance`, `observedAt`, and any other unexpected
field, so a browser cannot claim to be an onchain indexer or an analytics pipeline, and cannot
backdate evidence. An authenticated operator's submission is stamped `OPERATOR_INPUT` with the
server clock, and the operator address and session are persisted alongside it. `ONCHAIN_INDEXER`
and `ANALYTICS_PIPELINE` are reserved for internal collectors behind
`AgentDecisionService.decideTrusted`, which is not wired to any route; no code path fabricates
them today.

The authority boundary is explicit and differs by route. On the **manual** route the agent may
quote and prepare only; signing requires an authenticated operator and a one-time approval bound
to that settlement. On the **autonomous** route the agent does execute, but it may not choose its
recipient, its amount, its observation time, or its execution mode — all four are derived from
onchain evidence and policy — and it cannot exceed its transactionally enforced spend caps, its
per-market cooldown, or the durable pause switch.

## Circle Stablecoin Kits boundary

Arc's official App Kit documentation describes an SDK suite for composing Send, Bridge, Swap, and Unified Balance flows. MemeVerse does not ship the official App Kit SDK packages in its browser or server bundle. Instead, it exposes a truthful server-only Circle Stablecoin Kits boundary: authenticated **Swap Estimate** is live, while Send, Bridge, swap execution, and Unified Balance remain disabled until each has a separately reviewed implementation.

The latest official `@circle-fin/app-kit` and Circle Wallets adapter graph was re-evaluated on 2026-08-02 and still introduced 25 low/moderate runtime audit findings through unused Solana and legacy ethers paths. Those packages are not shipped. Instead, the backend uses Node's native `fetch` against the Circle Stablecoin Kits service contract, requires the server-only Kit Key and live Arc Testnet Circle wallet, validates that Circle echoes the exact wallet/tokens/amount, and discards prepared transaction data before returning an estimate. Runtime status is `AVAILABLE_AUDIT_CLEAN`; `npm audit` remains zero. This is intentionally a quote-only Circle integration, not a claim that MemeVerse ships the Arc App Kit SDK.

Run a non-transactional authenticated verification with:

```bash
npm run app-kit:verify
```

## Security posture

See [SECURITY.md](./SECURITY.md). The product links only to official Arc documentation, status, faucet, and explorer resources. MemeVerse support will never request a seed phrase, private key, wallet backup, or one-time code.

Arc post-quantum capabilities are currently a roadmap. MemeVerse does not claim post-quantum protection today. Future wallet and custody architecture must remain migration-ready and follow the [official Arc post-quantum documentation](https://docs.arc.io/arc/concepts/post-quantum-security).

## Arc Brand compliance

- Public copy uses descriptive language such as **Built on Arc**, **Available on Arc**, **Supports Arc**, or **Live on Arc**.
- Arc is not incorporated into the MemeVerse name, logo, company identity, or app icon.
- The repository contains no Arc logo asset; all bundled marks are original MemeVerse assets.
- Arc references describe infrastructure and do not imply endorsement, partnership, or an official Circle product.
- Any future co-marketing or Arc logo use requires review against the [Arc Brand Guidelines and Partner Toolkit](https://www.arc.io/brand-guidelines-and-partner-toolkit).

## Community contribution

Arc roles and points are external community programs and do not establish endorsement or technical readiness. MemeVerse progress should be shared through meaningful demos, documentation, testing feedback, and verifiable GitHub work—not role requests or low-effort promotional posts.

## Stack

- React + Vite
- wagmi + viem
- TanStack Query
- Circle Developer-Controlled Wallets SDK
- Circle Smart Contract Platform SDK
- PostgreSQL / PGlite
- Solidity 0.8.30
- MetaMask-compatible injected connector
- Arc Testnet

## Run locally

```bash
npm install
npm run check
npm run dev
```

The combined development command starts:

- Vite at `http://127.0.0.1:5173/memeverse/`
- the API at `http://127.0.0.1:8787`

Vite proxies `/api` in development. The backend writes records under `.data/`, which is intentionally ignored by Git. Copy `.env.example` to `.env.local` to override public and server-only configuration without tracking secrets.

PGlite is single-process development storage. Continuous separate workers require `DATABASE_URL`; run a one-shot local reconciliation only while the API is stopped:

```bash
WORKER_ONCE=true npm run start:worker
```

### Configure the Circle Arc Testnet wallet

Do not commit a populated `.env` file. Put Circle secrets in `.env.local`, which this repository ignores and loads only in the Node backend.

1. Create a Circle API key in the Circle Developer Console.
2. Generate and register the 32-byte entity secret using Circle's official entity-secret setup, and keep its recovery file outside this repository.
3. Add only these two secrets to `.env.local`:

```dotenv
CIRCLE_API_KEY=...
CIRCLE_ENTITY_SECRET=...
```

4. Provision the idempotent Arc Testnet EOA:

```bash
npm run circle:setup
```

5. Add the returned non-secret `CIRCLE_WALLET_SET_ID` and `CIRCLE_WALLET_ID` to `.env.local`.
6. Request Arc Testnet USDC from the [official Circle Faucet](https://faucet.circle.com/) and select Arc Testnet. The API command below is available only to Circle accounts upgraded for mainnet API access:

```bash
npm run circle:fund
```

7. Compile, deploy, source-verify, and approve the bounded settlement allowance:

```bash
npm run circle:deploy:settlement
npm run contracts:verify
npm run circle:approve:settlement
```

8. Save the non-secret contract and transaction IDs printed by those scripts in `.env.local`.
9. Set `SETTLEMENT_OPERATOR_ADDRESS` in `.env.local` to the checksummed address of the wallet allowed to authorize settlement. It is server-only and must never use a `VITE_*` prefix. Production refuses to start when Circle execution credentials are configured without it.
10. Start MemeVerse, open the Agent page, connect that wallet, sign the operator session, then review and approve the execution gate on the settlement receipt.

### Market contract operations

Compilation, local EVM tests, and onchain audits do not perform live writes:

```bash
npm run contracts:compile
npm run contracts:test
npm run markets:audit:onchain
```

The following commands are explicit Arc Testnet write operations and require the securely configured Circle EOA. They are never called by CI:

```bash
npm run circle:deploy:markets
npm run markets:verify
npm run markets:e2e:testnet
```

For asynchronous updates, expose `/api/webhooks/circle` through public HTTPS, set `CIRCLE_WEBHOOK_URL`, and run:

```bash
npm run circle:webhook:setup
```

Circle sends the signature and rotating key ID in headers; MemeVerse fetches the official public key, verifies the exact raw request body, and deduplicates delivery.

Run each process separately when needed:

```bash
npm run dev:api
npm run dev:web
```

## Production build

```bash
NODE_ENV=production npm run build
npm run preview          # serves dist and proxies /api to 127.0.0.1:8787 on one origin
```

Route-level code splitting keeps the initial payload small: the wallet, chain, React, Stage 2, and
Stage 3 surfaces are separate chunks and nothing exceeds 500 kB. A configured local production
build reports:

| Chunk | Raw | Gzip |
| --- | --- | --- |
| `chain` | 268.62 kB | 82.75 kB |
| `react` | 192.49 kB | 60.35 kB |
| `wallet` | 68.14 kB | 20.36 kB |
| `index` (application) | 61.78 kB | 18.11 kB |
| `stage3-views` | 22.59 kB | 6.91 kB |
| `stage2-views` | 14.50 kB | 4.92 kB |
| CSS | 53.44 kB | 9.57 kB |

**On comparing these numbers to CI.** Vite inlines `VITE_*` contract addresses at build time, so
a **configured local build** and a **clean unconfigured CI build** differ. Measured on this exact
commit: the local configured application chunk is **61.78 kB** and CI's is **61.57 kB** — CI has no
contract addresses to inline. Every other chunk, and the CSS, is byte-identical. Both numbers are
correct; they measure different builds, so always state which environment a bundle figure came
from.

`VITE_BASE_PATH` sets the build's base path. The committed default is `/memeverse/`; a root-domain
deployment sets `VITE_BASE_PATH=/`. The client router derives its basename from the same value, so
the two cannot disagree.

### Same-origin deployment

Operator sessions use an `HttpOnly`, `SameSite=Strict` cookie and the browser sends
`credentials: 'same-origin'`, so production must serve the frontend and the API from one origin,
normally behind a reverse proxy:

```text
https://app-domain.example/            → static frontend build
https://app-domain.example/api/...     → MemeVerse API
```

Set `APP_ORIGIN=https://app-domain.example` (a bare origin: no trailing slash, path, query, or
fragment — the value is canonicalized and validated at startup), leave `VITE_API_BASE_URL` empty
so the browser calls same-origin paths, and set `TRUSTED_PROXY_HOP_COUNT` to the number of proxies
actually in front of the API. A split-origin deployment would require `SameSite=None`, which
weakens CSRF protection; same-origin is the supported architecture.

Production refuses to start without managed PostgreSQL. Run the API and worker as separately supervised services:

```bash
NODE_ENV=production npm run db:migrate
NODE_ENV=production npm run start:api
NODE_ENV=production npm run start:worker
```

**SPA history fallback is required.** All eight routes (`/`, `/markets`, `/launch`, `/nft`,
`/vault`, `/agent`, `/quote`, `/safety`) must render on direct navigation and on refresh, so the
edge has to serve `index.html` for unmatched paths under the base:

```nginx
location /memeverse/ {
  alias /opt/memeverse/dist/;
  try_files $uri $uri/ /memeverse/index.html;

  # The static document is served by nginx, not by the API, so it does not inherit the API's
  # security headers. These three have to be sent here or the frontend has none.
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "no-referrer" always;
  # Deliberately frame-ancestors only. The full policy travels in the built document's
  # <meta http-equiv="Content-Security-Policy">, and frame-ancestors is the one directive a
  # browser is defined to ignore there — so it is the one directive that must come over HTTP.
  # Restating the whole CSP here would create a second copy to keep in sync, and the copy that
  # drifts is always the one in production.
  add_header Content-Security-Policy "frame-ancestors 'none';" always;
}
location /api/ {
  proxy_pass http://127.0.0.1:8787;
}
```

`add_header` does not merge across levels: a block that declares any `add_header` drops every
inherited one. Keep these three inside the `location` that serves the frontend rather than at
`server` level, and if you also set headers on the parent, restate them here too.

Run `db:migrate` once with `DATABASE_MIGRATION_URL` from a DDL-capable migration identity, **before** rolling out the API and worker. The API and worker use the lower-privilege `DATABASE_URL`; production runtime migration is forcibly disabled. Startup verifies every table *and column* the runtime writes and refuses to start against an outdated schema with `Database schema is outdated. Run npm run db:migrate.`, naming what is missing — so a skipped migration fails immediately rather than on the first settlement write. The readiness check reads the catalog only and runs no DDL. Hardened service templates are under `ops/systemd/`. Credentials must come from a secret manager rather than Git.

## Phase 3 verification evidence

- Deployment transaction: [`0x0125af5971f2f16d810174c5694b173dd779b8fdce6da3d73c9a77b490e43933`](https://testnet.arcscan.app/tx/0x0125af5971f2f16d810174c5694b173dd779b8fdce6da3d73c9a77b490e43933)
- End-to-end Memo settlement: [`0xbdd7b3edaf3a10bb8b81a8ef6eea1644fc04ccfd94ff938e3f528fdac4effac6`](https://testnet.arcscan.app/tx/0xbdd7b3edaf3a10bb8b81a8ef6eea1644fc04ccfd94ff938e3f528fdac4effac6)
- Indexed result: Circle `COMPLETE`, Arc event reconciliation `VERIFIED`, reservation `CONSUMED`

## Phase 5 verification

- Agent Policy V2 governs both routes: quote-and-prepare only on the manual operator route, and bounded autonomous execution on the Agent Wallet route.
- PostgreSQL daily-cap concurrency, webhook replay, and worker leasing are covered by automated tests.
- `npm run contracts:audit:onchain` performs read-only rejection tests against the deployed Arc contract.
- The internal review is documented in [`docs/PHASE-4-SECURITY-REVIEW.md`](./docs/PHASE-4-SECURITY-REVIEW.md).
- Authenticated Arc Testnet `USDC → EURC` estimation is verified through the server-only Stablecoin Kits boundary; no transaction is signed or broadcast.
- The official App Kit SDK package graph remains excluded because it still adds 25 audit findings; the active native-fetch boundary keeps `npm audit` at zero.
- The presentation flow, responsive layouts, explicit execution gate, and browser-to-API paths are documented in [`docs/PHASE-5-HANDOFF.md`](./docs/PHASE-5-HANDOFF.md).

## Phase 6A.1 verification evidence

- Exact-spend factory deployment: [`0xfc4aff2c762edae0d94c6a68a0bd77f6cfbd451f597e066801cba12faee66307`](https://testnet.arcscan.app/tx/0xfc4aff2c762edae0d94c6a68a0bd77f6cfbd451f597e066801cba12faee66307)
- Seed market launch: [`0x89fbc6f27d51457741dc58df278915628b928bb5efa70f2113074be3cad7e8e7`](https://testnet.arcscan.app/tx/0x89fbc6f27d51457741dc58df278915628b928bb5efa70f2113074be3cad7e8e7)
- Maximum 0.01 USDC approval: [`0x9c3ec3d3d3b35dffe8b6433eaf523dde202d3a073f8cb2f3c8dd137910159aea`](https://testnet.arcscan.app/tx/0x9c3ec3d3d3b35dffe8b6433eaf523dde202d3a073f8cb2f3c8dd137910159aea)
- Buy maximum 0.01 USDC → 97 MMV6A1, actual spend 0.009940 USDC: [`0x11b8dbd52d2db6a3f843b41771078ed0ad0f8fb62c76d7740e8d14f514e8c2b2`](https://testnet.arcscan.app/tx/0x11b8dbd52d2db6a3f843b41771078ed0ad0f8fb62c76d7740e8d14f514e8c2b2)
- Sell 48 MMV6A1 → 0.004739 USDC: [`0x8b69b0c7189ae20081d3783ddb3eb6e488081d909d334bfff1c3cc8858468bec`](https://testnet.arcscan.app/tx/0x8b69b0c7189ae20081d3783ddb3eb6e488081d909d334bfff1c3cc8858468bec)
- Final state: 49 MMV6A1 held, 0.004911 USDC curve reserve, exactly 0.004911 USDC market balance, and 0.000145 USDC each recorded as creator and treasury fees.
- `npm run markets:audit:onchain` independently matches factory and market runtime bytecode, immutable configuration, registry membership, fixed-supply accounting, reserve solvency, and exact reserve balance.
- The original Phase 6A deployment and identified limitation remain recorded in [`docs/PHASE-6A-ONCHAIN-MARKETS.md`](./docs/PHASE-6A-ONCHAIN-MARKETS.md).

## Phase 6A.2.1 verification

- A settlement can hold more than one valid approval, so submission passes through one atomic, database-level execution claim. Before the patch, two concurrent authorizations produced two Circle calls and twenty concurrent callers produced six, against both the in-memory and PGlite stores; after it, every case produces exactly one.
- The losing caller receives `409 EXECUTION_ALREADY_CLAIMED` and never reaches Circle. The winning authority is immutable.
- A crashed or undetermined attempt is resumable only after its lease expires, and only by reusing the same deterministic Circle idempotency identity, so a lost response cannot become a second payout.
- `APP_ORIGIN` is canonicalized to a bare origin and rejects a path, query, fragment, credential, or non-http(s) scheme.
- Expired operator challenges, sessions, and approvals are swept at startup and on a worker interval.

## Phase 6A.2.2 verification

- Quote expiry could invalidate an execution already under way. Reproduced against the pre-patch code, a settlement whose provider call outlived its quote became `EXPIRED`, released its treasury reservation, and then could not store the returning transaction at all (`Cannot transition settlement from EXPIRED to CONFIRMED`). Execution commitment now freezes expiry: a `CLAIMED`, `UNKNOWN_OUTCOME`, or `SUBMITTED` settlement never expires, and its reservation never releases.
- A settlement whose execution is undetermined still consumes treasury capacity however old its quote is, proven against PGlite.
- A claim lease could lapse under a healthy process, letting a second caller in while the first Circle request was alive. The claim holder now renews its lease through an ownership-conditional database write; a provider call held open for five full leases keeps its claim, rejects every rival with `409`, and yields exactly one Circle invocation. A claimant that stops beating is recoverable exactly as before, once its lease expires.
- A renewal presenting the wrong claim ID writes nothing at all — no lease, no authority, no version bump.
- Recovery no longer rewrites who originated a payout. `executionAuthorization` records the first authority ever to win a claim and is immutable; each attempt records its own authority, operator, session, claim ID, and outcome in `executionAttempts`. Across three recovery authorizations the provider operation identity stays byte-identical.
- An outdated database schema fails at startup with the missing columns named, and the readiness path is asserted statement by statement to run no DDL.
- A sold-out market reads `SOLD OUT` in the global ticker as well as on the Markets page; selling stays enabled on both.
- The design is documented in [`docs/PHASE-6A21-EXECUTION-CLAIM.md`](./docs/PHASE-6A21-EXECUTION-CLAIM.md).

## Phase 6A.2 verification

- Privileged settlement routes, settlement enumeration, and Circle wallet detail all require a server-verified operator session; anonymous callers are denied before any business logic.
- Operator sign-in is a real wallet signature over a server-generated, single-use, expiring challenge bound to origin, chain, scope, and nonce.
- Execution needs a second, settlement-bound, single-use approval that cannot be replayed or retargeted.
- A browser can no longer assert `ONCHAIN_INDEXER`, `ANALYTICS_PIPELINE`, or an evidence timestamp.
- Stale worker and webhook writes can no longer overwrite newer settlement state or evidence.
- No new contract was deployed. `npm run markets:audit:onchain` continues to audit factory `0x363124490E953EEbB414eB4c3e2f03a40eef8F2C` and seed market `0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D` with unchanged exact-spend economics.
- The design and residual risks are documented in [`docs/PHASE-6A2-TRUST-BOUNDARY.md`](./docs/PHASE-6A2-TRUST-BOUNDARY.md).

## Known limitations

- **No Circle wallet-level spend limits on Arc Testnet.** `circle wallet limit` is mainnet only, so every autonomous cap in force is application-level rather than enforced by the wallet itself.
- **`fraudRisk` is a heuristic score, not a fraud detector.** It measures onchain shape and cannot prove intent; the spend caps bound the damage rather than preventing manipulation.
- **The Agent Wallet session is time-bounded** (current Circle docs: 7 days; testnet and mainnet sessions are stored separately). Verify it with the Circle CLI before relying on it — when it lapses the agent reports `UNAVAILABLE` and stops paying until a human logs in again.
- **Autonomous execution needs the `circle` CLI on `PATH`** in the worker's environment; it is a subprocess dependency, not a library call.
- **Single Arc RPC** for the backend collector: a sustained outage means no autonomous decisions. The collector fails closed rather than guessing.
- **Arc Public Testnet MVP — not mainnet-ready.** The deployment at <https://memeverse.biz> is a live public Testnet MVP. Independent security review, operational hardening, custody review, and production monitoring are all required before any mainnet deployment.

## Post-hackathon hardening

- Connect an authenticated analytics/indexing pipeline behind `decideTrusted`.
- Add multi-operator support, role separation, and a documented operator rotation procedure.
- Deploy the API, worker, and managed PostgreSQL to a public testnet environment with backup and restore drills.
- Add Send, Bridge, swap execution, and Unified Balance only after separate transaction-policy and dependency reviews; capability discovery currently reports them disabled.
- Obtain an independent professional smart-contract audit before any mainnet consideration.

## License

MIT

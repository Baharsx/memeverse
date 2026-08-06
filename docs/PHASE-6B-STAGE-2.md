# Phase 6B — Stage 2 technical handoff

MemeVerse Stage 2 adds a real media/NFT layer, a real USDC vault, and a genuinely autonomous
creator-settlement agent that executes through a **Circle Agent Wallet** on Arc Public Testnet.

Everything below describes what is implemented and verified. Where a limitation exists, it says
so. No claim here exceeds demonstrated behaviour.

---

## 1. Scope

| Area | Status |
| --- | --- |
| 6B.0 superseded-claim late-error audit fix | Delivered, regression-tested |
| 6B.1 Media NFT + USDC marketplace | Delivered, deployed, live E2E |
| 6B.2 USDC vault (ERC-4626) | Delivered, deployed, live E2E |
| 6B.3 Autonomous creator settlement | Delivered, live autonomous payout |
| 6B.3 Circle Agent Stack integration | Delivered — Agent Wallet is the autonomous executor |
| 6B.3 Supervised autonomous worker | Delivered, restart/duplicate-safety tested |
| 6B.4 Frontend integration | Delivered — NFT, marketplace, vault, agent dashboard |

Stage 1 is unchanged. `MemeMarket`, `MemeVerseFactory`, and `MemeVerseSettlement` recompile to
byte-identical artifacts, so the deployed factory `0x363124490E953EEbB414eB4c3e2f03a40eef8F2C`
and seed market `0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D` were never redeployed.

---

## 2. Deployed Arc Public Testnet addresses

Chain ID `5042002`. Arc USDC `0x3600000000000000000000000000000000000000`.

| Contract | Address | Deployment tx |
| --- | --- | --- |
| `MemeVerseMediaNFT` | `0x56A6f87e4d026E6D9d3E3c791A3A30e023bf1CFD` | `0xa9020306326b58cb892fc34bd26d5555c50d3e17aac5f52230dd2b7c1962fe30` |
| `MemeVerseNFTMarketplace` | `0xfc3e869bA4Dd808A0942bc9C034f6f8427a08666` | `0xa9929127a1b98a19ca9e11d5f28d3bfa8398825bb4ba3d8dc95ceb845099eb78` |
| `MemeVerseVault` | `0xe26EeA49973226b406fd92Bd178484a29D7F7C05` | `0x69fbf387199e39894f40a2e480ca53373671c11965274dd98e02100d2d8be87b` |
| `MemeVerseSettlement` (autonomous) | `0x2176107C2562Ed30ca1d490C43cD53C3369946e2` | `0x9c3957a864e001d0cc31b8f6469f57af769c7a365343e886cc68687bb82b1aeb` |

Unchanged Stage 1: manual settlement `0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7`, Memo
`0x5294E9927c3306DcBaDb03fe70b92e01cCede505`, Multicall3From
`0x522fAf9A91c41c443c66765030741e4AaCe147D0`.

Verified by `npm run assets:audit:onchain` — runtime bytecode compared against the locally
compiled artifacts with immutable byte ranges masked, plus every immutable read back from chain.

---

## 3. Two settlement routes, deliberately isolated

|  | Manual operator | Autonomous agent |
| --- | --- | --- |
| Wallet | Circle **Developer-Controlled Wallet** (EOA) | Circle **Agent Wallet** (ERC-4337 SCA) |
| Address | `0x6bbD385C0f51D273a1685C977fAfa179F9eEb689` | `0x65da73c6d9300F3dAb1dF785219f76DeCA5e0FE3` |
| Routing | Arc Memo `CallFrom` → settlement contract | Direct call → settlement contract |
| Contract | `0x8E09979f…c5c9e7` | `0x2176107C…9946e2` |
| Plan operation | `ARC_MEMO_CONTRACT_SETTLEMENT` | `ARC_DIRECT_SETTLEMENT` |
| Authorization | Operator session + one-time settlement-bound approval | Internally minted, evidence-bound authority |
| Human in the loop | Yes, per payout | **No** |

The two routes share no wallet, no contract, and no USDC allowance.

### Why the Agent Wallet cannot use Arc Memo

A Circle Agent Wallet is an **ERC-4337 smart contract account**, not an EOA. This was established
empirically, not assumed:

* the wallet address had no bytecode and nonce 0 before first use, then gained 420 bytes of code;
* its first transaction was submitted by a bundler EOA (`0xa7fA08Fc…B762`) to the standard
  ERC-4337 EntryPoint (`0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`), yet `msg.sender` at the
  target was the wallet itself — the USDC allowance it set was recorded against the wallet;
* a probe calling Arc's `memo(address,bytes,bytes32,bytes)` from the Agent Wallet failed with
  `ESTIMATION_ERROR`.

Arc's Memo `CallFrom` extension only preserves a **directly signing EOA** as `msg.sender`, which
matches the constraint already recorded in `SECURITY.md`. The autonomous route therefore calls
`settle` on its own contract directly. Because `MemeVerseSettlement.operator` is immutable and the
existing instance is bound to the Developer-Controlled Wallet, a second instance was deployed with
the Agent Wallet as its immutable operator. The operator check was never loosened.

### What direct routing changes for reconciliation

Only the Memo assertions, because no Memo exists to assert on. `ArcSettlementIndexer.routingFor`
selects the mode from the execution plan and:

* **MEMO route** — unchanged and still strict: `transaction.to` must be the Memo contract, and the
  Memo event's sender, target, calldata hash, and memo bytes are all verified.
* **DIRECT route** — the settlement identity, operator, recipient, and amount are still proven by
  `SettlementExecuted`, and the money movement is still proven by the USDC `Transfer`. Two extra
  checks compensate for the missing Memo: the event must be emitted by the *configured* autonomous
  contract (a look-alike emitting the same event shape is rejected), and the operator is taken from
  the event rather than `transaction.from`, which for an ERC-4337 transaction is the bundler.

A regression test asserts that a Memo-routed record with no Memo event still fails, proving the
Developer-Controlled path was not relaxed.

---

## 4. Payout accounting: gross request versus creator payout

A live run showed a decided payout of `0.10` USDC next to an observed creator balance delta of
`+0.06` USDC. That was investigated rather than explained away.

**The money movement was correct.** Decoding the settlement transaction
`0xcca2c780…0b880c` shows `SettlementExecuted.amount = 60000` and a single USDC `Transfer` of
`60000` units from the Agent Wallet to the creator. Stage 1's `evaluateSettlementPolicy` splits a
**gross** request by `CREATOR_SHARE_BPS` (6000): the creator receives 60% and the remaining 40% is
*not transferred at all* — it simply stays in the wallet. `settle()` only ever moves
`creatorPayoutUnits`. So a `0.10` gross paying `0.06` is the contract behaving exactly as designed.

**Two things around it were wrong, and are fixed.**

1. `AGENT_AUTONOMOUS_MAX_PAYOUT_USDC` was named "payout" but bounded the *gross*, so a configured
   maximum of `0.10` could only ever pay a creator `0.06`.
2. The agent's daily-cap ledger recorded the gross (`100000`) while only `60000` left the wallet —
   inconsistent with the treasury reservation, which correctly reserves the net.

The autonomous caps now mean **what the creator receives**, which is also exactly what leaves the
wallet. `grossForCreatorPayout()` derives the gross needed to deliver a decided payout
(`gross = ceil(target × 10000 / bps)`, reduced to the smallest exact value) and the service fails
closed if the share configuration cannot express the target to the atomic unit. Epoch accounting
now records the real creator payout, so daily caps track real money movement. Both figures are
reported separately everywhere — E2E output, the status endpoint, and the dashboard — so they can
never be conflated again.

At a 60% share, a decided payout of `0.10` now issues a gross request of `0.166667` and delivers
exactly `0.100000` to the creator. Regression tests pin the round trip across several share
configurations, including the exact `60000`/`100000` case observed live.

---

## 5. Circle Agent Stack integration

Component used: **Agent Wallets**, via Circle's official CLI `@circle-fin/cli@0.0.6`
(<https://developers.circle.com/agent-stack/agent-wallets>).

* **Wallet model** — 2-of-2 MPC; key shares are never exposed to this process, and no private key
  is held or handled anywhere in the codebase.
* **Creation** — `circle wallet create` on `ARC-TESTNET`. Arc is first-class here: the CLI's own
  registry sets `DEFAULT_AGENT_CHAIN_TESTNET = "ARC-TESTNET"`.
* **Funding** — the Circle testnet faucet (`circle wallet fund`).
* **Execution** — `circle wallet execute "settle(bytes32,address,uint256)" … --idempotency-key`,
  invoked through `execFile` with an argument vector (never a shell string), so no settlement
  field can be interpreted as a shell metacharacter.
* **Idempotency** — the CLI accepts `--idempotency-key` and replays the original transaction for a
  repeated key. The gateway passes the settlement's `providerOperationKey`, which is exactly the
  contract the Stage 1 execution-claim machinery is built on.
* **Transaction status** — the CLI exposes no transaction-lookup verb, so rather than invent one
  the gateway resolves the outcome from Arc using the hash on the settlement record. That is
  stronger evidence and survives a restart. An unmined hash reports `SENT`, never a terminal state.

**Circle-level guardrails that are NOT active.** `circle wallet limit` (spending policies) is
**mainnet only** — the CLI states "testnets not supported". On Arc Testnet there are therefore no
wallet-level spend limits, and every cap in force is application-level. This is a real reduction in
defence-in-depth and is listed among the residual risks.

**Session handling.** Readiness reads `circle wallet status` and reports the testnet session's
`tokenStatus` and expiry. The account email that the CLI returns is deliberately dropped: it is a
personal identifier with no place in payout evidence, and a test asserts it never appears in
gateway output or the frontend.

---

## 6. 6B.0 — superseded-claim late-error audit fix

**Old behaviour.** `recordSubmissionFailure` returned early when the current claim ID no longer
matched, leaving the superseded attempt frozen at `CLAIMED` forever — a finished provider call
misreported as still running. The late-*success* path already handled this; the error path did not.

**New behaviour.** `recordSupersededSubmissionFailure` finalises only that historical attempt:
real status (`RELEASED` for `PRE_PROVIDER`, otherwise `UNKNOWN_OUTCOME`), failure classification
and code, and a `supersededByClaimId` naming the claim that took over, plus a dedicated history
reason `EXECUTION_FAILURE_BY_SUPERSEDED_CLAIM`. Claim ID, attempt number, and authority are
preserved.

It provably does **not** mutate the current submission, release the current claim, release treasury
capacity, rewrite `executionAuthorization`, create a retry, or make another provider call. An
unknown claim, or one already resolved, writes nothing — not even a row version.

Five regression tests cover it, including a PGlite test asserting the indexed `execution_claim_id`
still names the live claimant and `reservation_status` is still `ACTIVE`. Reverting the fix fails
three of them.

---

## 7. Media NFT and USDC marketplace

`MemeVerseMediaNFT` is an OpenZeppelin `ERC721URIStorage` (pinned `@openzeppelin/contracts@5.1.0`)
holding an immutable trusted factory. `mint` requires the market to be registered in that factory
and `msg.sender` to be its `creator()`, rejects a zero hash or empty URI, and rejects a content
hash already minted. Provenance is anchored to onchain state, not to a caller's claim; a contract
that merely implements `creator()` is rejected, as is a market from a different factory. There is
no owner and no privileged mint path, and provenance is immutable across transfers.

**Content hash scheme:** `contentHash = keccak256(<exact media file bytes>)`. Metadata is a
self-contained `data:application/json;base64` URI carrying the market, creator, hash, and scheme,
so it needs no host to stay resolvable.

`MemeVerseNFTMarketplace` is **fee-free** by choice — a cut would add rounding surface and a
privileged recipient without improving the product, so a sale moves exactly the listed price from
buyer to seller. The contract custodies nothing and its entire ABI is `buy`, `cancel`,
`isFillable`, `list`, `listings`, `nft`, `usdc`. `buy` deletes the listing before any external call
and is `nonReentrant`; it rejects a seller who no longer owns the token, a revoked approval, a
self-purchase, and any consumed listing. USDC moves via `SafeERC20`, so a false-returning token
reverts atomically.

**21 contract tests** cover forged provenance, unregistered and cross-factory markets, duplicate
content, stale listings, revoked approvals, insufficient allowance and balance, false-return USDC,
reentrancy from both a malicious `onERC721Received` buyer and a malicious ERC-20 callback, and the
absence of any admin surface.

---

## 8. USDC vault

`MemeVerseVault` is an OpenZeppelin `ERC4626` over Arc USDC; the constructor fails closed if the
asset is not six-decimal. **There is no yield** — no strategy, no APY, no rebasing.
`annualPercentageYieldBps()` returns a literal `0` so no consumer has to invent a number. No owner,
admin, pauser, upgrade path, or fee exists.

**Share inflation** is mitigated with a **decimals offset of 6** (12-decimal shares), tuned against
a measurement rather than a guess: at offset 3 a 10,000 USDC donation staged against a 1,000 USDC
victim deposit cost that victim ~0.45%; at offset 6 the same attack costs ~0.0045 USDC — under one
basis point — and the attacker must donate ~10⁶× what they hope to strand, unrecoverably.

**16 contract tests** assert a solvency invariant at every step (`totalAssets` equals the real
balance; `previewRedeem(totalSupply) ≤ balance`), the one-atomic-unit boundary, exact-mint rounding
directed against the depositor, donations, allowance-gated delegated redeem, false-return USDC,
callback reentrancy, and that neither the deployer nor a third party can withdraw another wallet's
assets.

---

## 9. Autonomous agent

### Trust boundary

The autonomous path accepts **nothing** from a caller, and no route reaches it.

| Input | Source |
| --- | --- |
| Signal provenance | Assigned internally as `ONCHAIN_INDEXER` |
| Recipient | `market.creator()` of a factory-registered market |
| Payout amount | Derived from the decided score by formula |
| Observation time | The evidence **anchor block's** timestamp, not the host clock |
| Execution mode | Set by the internally minted authority |
| Authorization | Minted in-process; unforgeable over HTTP |

### Signal collector

`ArcMarketSignalCollector` re-verifies the chain ID on every collection, resolves the market
through `factory.isMarket`, and reads the creator from the market. Windows end
`AGENT_MIN_CONFIRMATIONS` behind the head; the anchor block number and hash are recorded.

Logs are read in sequential bounded pages with exponential backoff. Arc's public RPC caps ranges
near 10,000 blocks and rate-limits bursts, and a throttled `eth_getLogs` is indistinguishable from
an empty one — so pages are never concurrent, and an exhausted retry budget marks the evidence
`logsComplete: false` rather than silently reporting "no trades happened".

### Metric definitions (`AGENT_SIGNAL_METRICS_V1`)

Integer arithmetic, 0..100, deterministic. `ratio(v, t) = min(100, floor(100·v/t))`.

* **engagementVelocity** = `floor((ratio(tradeCount, 8) + ratio(volumeUnits, 5 USDC)) / 2)`
* **holderRetention** = `floor(100 · (grossBought − soldBack) / grossBought)`, else 0 — an onchain
  retention proxy over the window, explicitly *not* a claim about offchain holders
* **liquidityDepth** = `ratio(reserveUsdc, 5 USDC)`
* **confidence** = `min(confirmation, sample, history, completeness)` — the minimum, not an
  average, because a single missing input must not be averaged away by strength elsewhere
* **fraudRisk** = additive penalties clamped to 100: no confirmed trades (+50), market younger than
  500 blocks (+40), fewer than 2 independent traders (+30), one trader above 60% of volume (up to
  +30, scaled), churn above 50% (+20), incomplete history (+50)

`fraudRisk` is a **risk score built from crude heuristics, not a fraud detector.** It cannot prove
intent, and a low score is not a statement that a market is honest.

**Evidence digest** = `keccak256` over chain ID, factory, market, creator (lowercased), anchor block
hash, policy version, metric version, window, signals, and raw observations.

### Payout derivation (`AGENT_PAYOUT_V1`)

```
payout(score) = min + floor((max − min) × (score − floor) / (100 − floor))
```

Exact six-decimal BigInt arithmetic; no floating point touches an authoritative amount. Caps clamp
in widening order — per execution, per market per day, global per day — and a remainder below the
configured minimum is refused rather than paid as dust. All of these bound the **creator payout**
(§4). Committed defaults are production-safe: `MAX=0.10`, `MIN=0.01`, `MARKET_DAILY=0.30`,
`SCORE_FLOOR=70`, `COOLDOWN=3600s`, `AGENT_AUTONOMOUS_ENABLED=false`.

### Cooldown, authority, pause

The payout epoch is `floor(anchorBlockTimestamp / cooldownSeconds)` — chain time, so every worker
computes the same epoch. `agent_payout_epochs` is keyed on `(market, policy version, epoch)`;
concurrent workers collide on one insert and exactly one proceeds. The settlement idempotency key
is `autonomous:<market>:<policyVersion>:<epoch>`, so a crash and restart resolves to the same
settlement.

`mintAutonomousAuthority` stamps a **module-private `Symbol`**. JSON cannot carry a Symbol-keyed
property, so no request — including a byte-perfect copy of a genuine authority — passes
`isAutonomousAuthority`. `AUTONOMOUS_POLICY` being an enabled mode grants nothing; the brand is the
gate. The authority carries no secret, only identities, hashes, and an expiry.

`settlementService.executeAutonomous` is the only entry point that can execute one and is not
reachable from the transport. Its `preflight` re-asserts, in the last moment before the claim, the
pause switch, decision freshness, the anchor block hash (rejecting a reorg), market registration,
and the creator address.

The pause switch lives in `agent_runtime_control` and **defaults to paused** — a missing row reads
as paused, so autonomy can never default itself into spending. `POST /api/v1/agent/autonomy`
accepts only `{ paused, reason }`; naming a market, recipient, amount, mode, provenance, or
timestamp is a 400.

### Supervised worker

`AutonomousAgentWorker` discovers registered markets each tick and evaluates each in turn. It runs
only when `AGENT_AUTONOMOUS_ENABLED=true` **and** an Agent Wallet is configured — absent either it
does not start, and it never silently falls back to spending from the manual treasury. Pause is
checked before any work is created. One market's failure never starves the sweep. Ticks never
overlap. A per-tick bound keeps a large registry from making one sweep unbounded. `stop()` drains
an in-flight tick rather than abandoning it.

Duplicate protection is not a mutex — it is the epoch primary key. **Nine worker tests** cover the
full sweep, pause, per-market failure isolation, discovery failure, tick overlap, a ten-worker race
producing exactly one payout, restart safety against an already-settled epoch, scheduling and clean
shutdown, and the per-tick bound.

### Concurrency claim

Stage 1's optimistic concurrency, atomic execution claim, lease heartbeat, deterministic provider
idempotency, and reconciliation are reused unchanged; Stage 2 adds one database primitive.

The guarantee is unchanged and stated truthfully: **at-most-one active provider-call owner while a
healthy claimant renews its lease, plus deterministic provider idempotency and recovery after
claimant loss.** A VM pause or network partition may still outlive a lease. This is **not** a claim
of exactly-once external delivery.

---

## 10. Frontend

The Stage 1 simulated NFT archive and Vault surfaces are **deleted**, not merely unrouted, along
with their `demoCoins`/`nfts` datasets. A test asserts the components and their demo strings are
gone from `main.jsx`.

* **`/nft` — Media assets.** Real collection enumerated from `totalMinted` (not a log scan, which
  Arc's RPC would throttle into an incomplete gallery). Shows token ID, creator, market, owner,
  mint block, content hash, media, and live listing state. A creator can mint, approve, and list;
  an owner can cancel; a buyer can approve USDC and buy. A listing whose seller moved the token or
  revoked approval renders as **stale and unbuyable** rather than being offered.
* **`/vault` — USDC vault.** Real total assets, wallet balance, share balance, redeemable assets,
  and the contract's own `annualPercentageYieldBps` (`0`). Approve, deposit, redeem.
* **`/agent` — Autonomous dashboard**, mounted above the manual operator flow and clearly separated
  from it. Shows ACTIVE/PAUSED, policy version, executor (provider, address, `SCA`, session state),
  caps, thresholds, and for each recent payout: signal source, evidence range, signals, confidence,
  risk score, policy result, execution mode, **human approval YES/NO**, executing wallet, Circle
  state, Arc tx, and reconciliation status with route — all with ArcScan links.

Transaction state is rendered from the real lifecycle (`WAITING FOR WALLET` → `PENDING ON ARC` →
`CONFIRMED`/`FAILED`); nothing is shown as complete before its receipt. Wallet disconnected, wrong
network, unconfigured contract, RPC failure, empty collection, and no-position all render explicit
states instead of placeholder data. The views are lazy-loaded into a separate 24 kB chunk, and the
brutalist pixel-grid identity (`#0B0B0D`, `#C6F432`, `#F4F3EF`) is preserved.

---

## 11. Database

New tables, all in `schemaSql` and all listed in `requiredColumns`, so a migration-disabled
production start fails fast rather than breaking on first write:

* `agent_runtime_control` — the durable pause switch, defaults to paused.
* `agent_payout_epochs` — PK `(market_address, policy_version, epoch)`; the cooldown and the
  duplicate-payout guard are the same constraint. `amount_units` records the **creator payout**.
* `agent_collector_checkpoints` — monotonic scan cursors; a stale worker cannot rewind them.

The one-shot migration identity model is preserved; no runtime production DDL was added.

---

## 12. Live Arc Testnet evidence

### NFT lifecycle

Seller `0x6bbD385C…eb689` (genuine creator of market `0xBe6E56a8…f2d39D`); buyer
`0xBc5F97E6…c1709`, a separate funded Circle wallet.

| Step | Tx |
| --- | --- |
| Mint token #1 | `0x29927cb3d25aefaec620408708366cc0a8cc1a67fe324cacaeae18c45c058bca` |
| Approve marketplace | `0x7b16516b38ca99d78ea74c915f13378bac35a2ab673b10dfd0c810cf082b1285` |
| List at 0.25 USDC | `0xb3646e175c18432b1013c30f0267bbaf2e9867ae58a9881c22e98533b224cc3d` |
| Buyer approves USDC | `0xd445b77872bb85cd8ceca69e9c36c0a9a908382bf90006da042af60d73f5e4fd` |
| Purchase | `0xfa9285c6b642f70fc5b75bf47811168d80ec4eb994cd8545e3b7813d8baf2231` |

Content hash `0x612d144b…7edb4fb` = `keccak256(public/memeverse-mark.png)`. Seller delta **exactly
+0.250000 USDC**; buyer −0.253575 (price plus Arc gas). Listing consumed, marketplace balance zero.

### Vault lifecycle

| Step | Tx |
| --- | --- |
| Approve 1.00 USDC | `0x6e3d39ba16bdf1679b9f2ba417dcef61782ff930f1db37c987f64860e53c6b9c` |
| Deposit 1.00 USDC | `0x6f922cb7b3310693bc48f190631629c3daefb3749339bb67fbb8264d82b1b149` |
| Redeem all shares | `0x1bb46a30ca9d01aaf74dac415923ab7f18bd0a10fb6cc3de2c9e76c12e728825` |

Position `1000000000000` shares (12-decimal), redeemable exactly 1 USDC, full principal returned,
solvency asserted throughout.

### Autonomous payout via the Circle Agent Wallet

Market `0xE8ec1307fd500dF01CE0265167C05d8FfE4394DE`, created by the counterparty wallet so the
creator is **not** the paying wallet. Twelve real buys from two distinct traders were generated
first so the market genuinely clears policy — thresholds were not lowered to fit a quiet market.

* Provenance `ONCHAIN_INDEXER`; creator read from `market.creator()`
* Window blocks 55585878 → 55586500, head 55586512, 12 confirmations
* Anchor `55586500` / `0x1ccfa208…bf76a3`; `observedAt` from the anchor block
* Raw: 12 trades, 2 unique traders, 8.398671 USDC volume, 8.234001 USDC reserve, `logsComplete: true`
* Signals: engagement 100, retention 100, liquidity 100, **confidence 100, fraudRisk 0**
* Evidence digest `0xdff574a2…b5452d`
* Settlement `38ebb081-ec86-4799-95ec-34fcc9ad2b0a`, epoch `496114`
* Circle transaction `39510412-8eba-5c8d-896e-40bd8c0d74cc`
* **Arc tx `0xcca2c7803c86a53ee346c5d5a71c497821b25f93f485b06b7843eb050a0b880c`**
* Execution plan `CIRCLE_AGENT_WALLET` / `ARC_DIRECT_SETTLEMENT`; executed by
  `0x65da73c6…0FE3`; onchain operator confirmed as the Agent Wallet
* **executionMode `AUTONOMOUS_POLICY`; operatorAddress `null`; sessionId `null`; human
  authorization consumed: NO**
* Reconciliation **VERIFIED** via the `DIRECT` route; reservation `CONSUMED`; 1 provider attempt
* Creator delta **+0.060000 USDC**, matching `SettlementExecuted.amount = 60000` exactly (§4)
* Immediate re-evaluation returned `MARKET_IN_COOLDOWN`
* Autonomy returned to its paused fail-safe automatically at the end of the run

#### Verification run after the payout-accounting fix (§4)

A second autonomous payout was executed once the caps were corrected to mean the creator payout,
proving the fix against the chain rather than only in tests:

* Settlement `90680815-49cf-41f4-8411-01fdf40d1b0d`, epoch `496116`
* Circle transaction `e9b9796b-1c1f-5fe3-b71b-87f5e8e197b7`
* **Arc tx `0xffad62e616262a682dcfd0ac85a7ced9f7b16290b29beadec6225e008c6b6799`**
* Anchor `55610720` / `0x857e7555…b4089a`; signals 100/100/100, confidence 100, fraudRisk 0
* Decided creator payout `0.100000` USDC; gross request `0.166667`; treasury retained `0.066667`
* **Creator delta +0.100000 USDC — exactly the decided payout**, where the pre-fix run delivered
  0.06 against a decided 0.10
* executionMode `AUTONOMOUS_POLICY`; operatorAddress `null`; sessionId `null`; human authorization
  consumed: NO; 1 provider attempt; reservation `CONSUMED`
* Reconciliation **VERIFIED** via the `DIRECT` route against `0x2176107C…9946e2`, onchain operator
  confirmed as the Agent Wallet
* Immediate re-evaluation returned `SPEND_CAP_EXCEEDED` — the 0.30 USDC per-market daily cap was
  exhausted by three payouts, so the cap itself is demonstrated, not just the cooldown

---

## 13. Tests

216 backend tests and 54 contract tests pass; `npm audit` reports 0 vulnerabilities.

New coverage: 5 superseded-claim late-error regressions, 21 NFT/marketplace, 16 vault, 21
autonomous agent (metrics, confidence-minimum semantics, risk heuristics, digest sensitivity,
payout curve, cap boundaries, gross-versus-creator-payout round trips, epoch stability, authority
unforgeability including a JSON round trip, pause fail-safe, 12-way epoch race, cap accounting,
checkpoint monotonicity), 9 supervised worker, 13 Agent Wallet gateway and direct-route
reconciliation, 5 route rejection, and 9 frontend helper tests including an ABI-versus-artifact
drift check and a no-simulated-data assertion.

The original 17 Stage 1 market contract tests are unchanged and still pass.

---

## 14. Residual risks and limitations

1. **No Circle wallet-level spend limits on testnet.** `circle wallet limit` is mainnet only, so
   every cap in force is application-level. Defence in depth is one layer thinner than it would be
   on mainnet.
2. **`fraudRisk` is a heuristic.** It detects shape, not intent. A patient, well-funded adversary
   can trade a market into a passing profile; the caps bound the damage rather than preventing the
   manipulation.
3. **Metric targets are compile-time constants.** `defaultMetricConfig` is not environment-tunable,
   so a much larger market saturates every score at 100.
4. **Single Arc RPC.** The collector fails closed on rate limits, but a sustained outage means no
   autonomous decisions. No fallback RPC is wired into the backend collector.
5. **Reorgs deeper than the confirmation depth** would invalidate an anchor. The preflight rejects a
   reorganised anchor before payment, but a reorg landing between preflight and Circle acceptance is
   not preventable — reconciliation is the backstop.
6. **The Agent Wallet session expires.** The CLI session is time-bounded (~28 days); when it lapses
   the agent reports `UNAVAILABLE` and stops paying until a human logs in again.
7. **The CLI is a subprocess dependency.** Autonomous execution requires the `circle` binary on
   `PATH` in the worker's environment; it is not a library call.
8. **The E2E scripts spend real testnet USDC** and leave a funded counterparty wallet in existence.
9. **Not independently audited.** No third-party security review has been performed.

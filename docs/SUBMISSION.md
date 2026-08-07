# MemeVerse — hackathon submission

Everything below is copy that can be pasted into a submission form as-is. Every claim is
verifiable against the addresses and transaction hashes in this file.

---

## Official requirements checked

### Publicly verified — Arc House event page, checked 7 August 2026

Governing source: **<https://community.arc.io/public/events/hackathon-programmable-money-74llz8htis>**
(the official Arc House page for the online hackathon). Everything in this table was read directly
off that page on the date given.

| Item | What the page states |
| --- | --- |
| Programme window | **13 July – 22 August 2026** |
| Deliverable 1 | Functional MVP with working frontend **and** backend |
| Deliverable 2 | **3-minute** video pitch and demo covering core functionality *and* use of Circle tools |
| Deliverable 3 | Link to the code repository |
| Tracks | **DeFi** and **Agentic** |
| Judging | A working prototype deployed on Arc · clear use of Circle's developer tools · a real use case with a path to production · quality of execution over complexity |

**Track chosen: Agentic** (MemeVerse also satisfies the DeFi criteria through its bonding-curve
markets, USDC marketplace, and ERC-4626 vault).

### ⚠ VERIFY IN THE ENCODE PARTICIPANT DASHBOARD BEFORE SUBMISSION

The following are **not** exposed on the public Arc House page and could not be confirmed from an
authoritative source. They may well be correct — Encode publishes its detailed schedule inside the
participant dashboard, which is not publicly readable — but this repository must not present them
as verified requirements, and no date here should be treated as the deadline until a human has
checked the dashboard.

| Unverified item | Status |
| --- | --- |
| A final submission checkpoint on **9 August 2026** | **UNVERIFIED.** Not on the public page. Seen only in third-party summaries of the Encode schedule view. |
| Demo Day on **20 August 2026** | **UNVERIFIED.** Not on the public page. |
| An **Anywhere-on-Earth** deadline timezone | **UNVERIFIED.** The public page quotes times in GMT and carries no AoE wording. |
| A required **deck / slide presentation** | **UNVERIFIED.** The public page lists three deliverables and does not name a deck. |
| Prize: top teams entering an 8-week accelerator | **UNVERIFIED.** Not on the public page. |

Third-party write-ups and the separate in-person *Encode x Arc DeFi Hackathon*
(<https://luma.com/rjsr5r3a>) were also read, but neither is a governing source for this online
hackathon and neither is relied on above.

**Human action item: open the Encode participant dashboard, confirm the real submission deadline
and deliverable list, and correct this section before submitting.**

### Gaps against the deliverables — read before submitting

1. **No hosted demo URL exists yet.** The contracts are deployed and live on Arc Public Testnet,
   and the frontend and backend both run, but the application itself is not yet hosted at a public
   address. Deployment topology and configuration are documented in `README.md` and
   `docs/STAGE-3-FINAL.md`; choosing and provisioning a host is **a human action item**.
2. **The 3-minute video has not been recorded.** `docs/DEMO-SCRIPT.md` is the timeboxed script for
   it, including the Circle-tools coverage the official criteria ask for.
3. **No deck exists in this repository.** A deck is not among the three publicly listed
   deliverables, so this may not be required at all — see the unverified table above. An outline is
   provided at the end of this file in case it is.

---

## Project name

**MemeVerse**

## One-liner

A meme becomes a real Arc economy, and an autonomous Circle Agent Wallet pays its creator in USDC
without a human approving the payment.

## Tagline

**A meme becomes an economy.**

## Problem

Meme culture creates enormous economic value and returns almost none of it to the people who make
it. A creator whose meme drives millions of impressions owns nothing programmable: no asset, no
claim on the activity their work generates, no provenance over the media itself. Value accrues to
platforms and to speculators, and it is distributed — when it is distributed at all — by manual,
discretionary, off-chain decisions. There is no mechanism that observes real economic activity and
routes a share of it back to the originator automatically.

## Solution

MemeVerse gives a meme its own economy and then puts an autonomous agent inside that economy.

1. A creator deploys a real Arc contract: a fixed-supply token and its USDC bonding market.
2. Anyone trades it in USDC. Every buy and sell pays the creator and the treasury inside the same
   transaction.
3. The creator mints media bound onchain to a market they provably created, and sells it for USDC.
4. A deterministic policy agent reads confirmed Arc trading evidence, decides on its own whether
   the creator has earned a reward, and pays them from a **Circle Agent Wallet** — with no human
   in the execution path.
5. Every step resolves to an Arc transaction anyone can verify independently.

## Why Arc

Only the properties MemeVerse actually depends on:

- **USDC is native money and native gas.** A creator payout, a market trade, an NFT sale, and the
  transaction fee are all denominated in the same asset. The agent's spending caps, its treasury
  reservations, and its gas are one unit of account — there is no second volatile asset to hold,
  price, or hedge, which is what makes a bounded autonomous spend policy expressible at all.
- **EVM contracts.** The bonding-curve market, factory, media NFT, marketplace, ERC-4626 vault,
  and both settlement contracts are ordinary Solidity, deployed and verified against locally
  compiled artifacts.
- **Sub-second settlement.** A payout confirms inside a live demo rather than after it.
- **Arc Transaction Memos.** The manual operator route uses Memo `CallFrom` to bind an application
  settlement record to its onchain call. The autonomous route deliberately does not — see below.
- **The Circle developer platform is built in**, which is what made a real Agent Wallet the
  executor rather than a self-custodied key.

## Why Circle

| Circle product | How MemeVerse uses it |
| --- | --- |
| **USDC on Arc** | Every market trade, fee, NFT sale, vault deposit, and creator payout |
| **Agent Wallets (Agent Stack)** | The autonomous executor. An ERC-4337 smart account created with the official Circle CLI, backed by 2-of-2 MPC. It signs every autonomous creator payout. No private key exists in this codebase. |
| **Developer-Controlled Wallets** | The separate, human-authorized operator settlement route, and the deployer identity |
| **Smart Contract Platform** | Deployed every MemeVerse contract on Arc Testnet |
| **Stablecoin Kits (App Kit)** | Live authenticated USDC/EURC swap estimates on `/quote`. The Kit Key never leaves the server and no transaction is ever signed or broadcast from that surface. |
| **Circle webhooks** | Signature-verified settlement state notifications |
| **Circle faucet** | Testnet USDC funding |

Not used, and not claimed: CCTP, Gateway, Paymaster, Nanopayments.

## Core flow

**Create → Trade → Own → Reward → Prove**

## Tech stack

React 19 + Vite (no framework router, ~61 kB app chunk) · wagmi + viem · Express 5 · PostgreSQL ·
Solidity 0.8.30 + Hardhat 3 · Circle Developer-Controlled Wallets, Agent Wallets, Smart Contract
Platform, Stablecoin Kits · Arc Public Testnet (chain `5042002`).

---

## Contracts — Arc Public Testnet, chain 5042002

| Contract | Address |
| --- | --- |
| `MemeVerseFactory` | [`0x363124490E953EEbB414eB4c3e2f03a40eef8F2C`](https://testnet.arcscan.app/address/0x363124490E953EEbB414eB4c3e2f03a40eef8F2C) |
| `MemeVerseMediaNFT` | [`0x56A6f87e4d026E6D9d3E3c791A3A30e023bf1CFD`](https://testnet.arcscan.app/address/0x56A6f87e4d026E6D9d3E3c791A3A30e023bf1CFD) |
| `MemeVerseNFTMarketplace` | [`0xfc3e869bA4Dd808A0942bc9C034f6f8427a08666`](https://testnet.arcscan.app/address/0xfc3e869bA4Dd808A0942bc9C034f6f8427a08666) |
| `MemeVerseVault` (ERC-4626) | [`0xe26EeA49973226b406fd92Bd178484a29D7F7C05`](https://testnet.arcscan.app/address/0xe26EeA49973226b406fd92Bd178484a29D7F7C05) |
| `MemeVerseSettlement` — autonomous | [`0x2176107C2562Ed30ca1d490C43cD53C3369946e2`](https://testnet.arcscan.app/address/0x2176107C2562Ed30ca1d490C43cD53C3369946e2) |
| `MemeVerseSettlement` — manual operator | [`0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7`](https://testnet.arcscan.app/address/0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7) |
| Arc USDC | `0x3600000000000000000000000000000000000000` |
| Arc Memo | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` |

Seed market `0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D`. Agent-rewarded market
`0xE8ec1307fd500dF01CE0265167C05d8FfE4394DE`.

## Wallets

| Role | Address | Type |
| --- | --- | --- |
| **Circle Agent Wallet** — autonomous executor | [`0x65da73c6d9300F3dAb1dF785219f76DeCA5e0FE3`](https://testnet.arcscan.app/address/0x65da73c6d9300F3dAb1dF785219f76DeCA5e0FE3) | ERC-4337 smart account (MPC) |
| Circle Developer-Controlled Wallet — manual operator | [`0x6bbD385C0f51D273a1685C977fAfa179F9eEb689`](https://testnet.arcscan.app/address/0x6bbD385C0f51D273a1685C977fAfa179F9eEb689) | EOA |

The two routes share no wallet, no settlement contract, and no USDC allowance.

## Live proof

**Autonomous creator payouts — executed by the Circle Agent Wallet, no human approval:**

| Arc transaction | Creator received | Reconciliation |
| --- | --- | --- |
| [`0xffad62e616262a682dcfd0ac85a7ced9f7b16290b29beadec6225e008c6b6799`](https://testnet.arcscan.app/tx/0xffad62e616262a682dcfd0ac85a7ced9f7b16290b29beadec6225e008c6b6799) | **0.100000 USDC** | VERIFIED (DIRECT route) |
| [`0xcca2c7803c86a53ee346c5d5a71c497821b25f93f485b06b7843eb050a0b880c`](https://testnet.arcscan.app/tx/0xcca2c7803c86a53ee346c5d5a71c497821b25f93f485b06b7843eb050a0b880c) | 0.060000 USDC | VERIFIED (DIRECT route) |

Both recorded `executionMode: AUTONOMOUS_POLICY`, `operatorAddress: null`, `sessionId: null`,
human authorization consumed: **NO**.

**Media NFT lifecycle — mint, list, and a real USDC sale between two distinct wallets:**

| Step | Arc transaction |
| --- | --- |
| Mint token #1 | `0x29927cb3d25aefaec620408708366cc0a8cc1a67fe324cacaeae18c45c058bca` |
| List at 0.25 USDC | `0xb3646e175c18432b1013c30f0267bbaf2e9867ae58a9881c22e98533b224cc3d` |
| Purchase | `0xfa9285c6b642f70fc5b75bf47811168d80ec4eb994cd8545e3b7813d8baf2231` |

Seller balance delta: exactly **+0.250000 USDC**.

**Vault lifecycle — deposit and full redemption:**

| Step | Arc transaction |
| --- | --- |
| Deposit 1.00 USDC | `0x6f922cb7b3310693bc48f190631629c3daefb3749339bb67fbb8264d82b1b149` |
| Redeem all shares | `0x1bb46a30ca9d01aaf74dac415923ab7f18bd0a10fb6cc3de2c9e76c12e728825` |

## Repository

<https://github.com/Baharsx/memeverse>

## Demo URL

Not yet hosted. The contracts are live on Arc Public Testnet at the addresses above and can be
verified independently right now; the application runs locally with `npm run dev`. Production
deployment topology is documented in `README.md`.

---

## Description — 50 words

MemeVerse turns a meme into a real Arc economy. Creators deploy USDC bonding-curve markets, earn
from every trade, and mint market-bound media NFTs. A deterministic autonomous agent reads
confirmed onchain trading evidence and pays creators from a Circle Agent Wallet — no human
approves the payment, and every step is verifiable on Arc.

## Description — 150 words

MemeVerse gives a meme its own economy and puts an autonomous economic actor inside it.

A creator deploys a real Arc contract: a fixed-supply token and its USDC bonding market. Anyone
trades it; every buy and sell pays the creator and the treasury in the same transaction. The
creator mints media bound onchain to a market they provably created, and sells it for USDC.

Then the part that is genuinely new: a deterministic policy agent reads confirmed Arc trading
evidence — trade count, distinct traders, curve liquidity, risk shape, scan completeness — scores
it, and if the market clears policy it pays the creator from a **Circle Agent Wallet**. No human
approves an individual payout. Spend is bounded by transactional daily caps, one payout per market
per epoch, and evidence-bound authority minted in-process.

Every decision resolves to an Arc transaction, reconciled against its own contract events.

## Description — 300 words

Meme culture creates enormous economic value and returns almost none of it to the people who make
it. Creators own nothing programmable: no asset, no claim on the activity their work generates, no
provenance over the media. Distribution, where it happens, is manual and discretionary.

MemeVerse makes that economy real and then automates the part that has always been manual.

**Create.** A creator deploys a fixed-supply token and its USDC bonding-curve market from their own
wallet, through an immutable factory on Arc Public Testnet.

**Trade.** Anyone buys and sells against the curve in USDC. Creator and treasury fees settle inside
the same transaction — the creator earns from activity, not from a payout schedule.

**Own.** The creator mints media NFTs whose provenance is enforced onchain: the contract verifies
the market is registered in the trusted factory and that the minter is its `creator()`. Media then
trades for USDC on a marketplace that charges no fee.

**Reward.** A deterministic policy agent evaluates registered markets against confirmed Arc
evidence collected by its own indexer — never from a browser request. It derives its recipient from
`market.creator()`, its amount from the decided score, and its observation time from the Arc anchor
block. If the market clears policy, it pays the creator from a **Circle Agent Wallet**, an ERC-4337
smart account backed by MPC. **No human approves an individual payout.**

**Prove.** Every payout is reconciled against `SettlementExecuted` and the USDC `Transfer` on Arc,
with the expected operator taken from configuration rather than from the event being verified.

Safety is structural: atomic global and per-market daily spend reservations in PostgreSQL, one
payout per market per epoch enforced by a primary key, and capacity that is never released on an
undetermined provider outcome.

336 tests. Zero dependency vulnerabilities. Arc Public Testnet only.

## Technical summary

Solidity 0.8.30 contracts on Arc Public Testnet (chain 5042002): an immutable market factory, a
linear bonding-curve market with in-transaction creator and treasury fee splits, a media NFT whose
mint path verifies factory-registered market provenance and de-duplicates content commitments, a
zero-fee USDC NFT marketplace, an ERC-4626 vault, and two isolated settlement contracts each with a
different immutable operator.

The backend is Express 5 over PostgreSQL. Autonomous settlement runs in a separately supervised
worker: an Arc log collector produces deterministic signal metrics from confirmed trades, a
versioned policy scores them, a payout curve derives the amount, and a durable epoch claim plus an
atomic spend reservation admit the spend. Execution passes through the same claim, lease
heartbeat, optimistic concurrency, and reconciliation machinery as the manual route, with only the
provider gateway swapped for the Circle Agent Wallet.

The frontend is React 19 on Vite with route-level code splitting — the wallet, chain, Stage 2, and
Stage 3 chunks are separate, and no chunk exceeds 269 kB.

## Agentic-economy summary

The agent is an economic actor, not an assistant. It has a wallet, a budget, a policy, and a
cooldown, and it spends real USDC without asking. It observes an economy it does not control
(markets other people created and other people trade), forms a verdict from confirmed onchain
evidence, and settles value to a counterparty it derived itself from contract state. What bounds it
is not a human reviewer but structure: transactional daily caps, a primary-key cooldown, an
evidence-bound authority that cannot be minted outside the process, and a reconciliation step that
refuses to mark a payout verified unless the chain agrees.

## DeFi summary

Every MemeVerse asset is USDC-denominated and settles onchain. Meme markets are linear bonding
curves with a fixed supply and an explicit reserve, quoting buys and sells with exact-spend
semantics and slippage bounds. Creator and treasury fees are split inside the trade rather than
accrued off-chain. Media NFTs trade through a marketplace that takes no fee and refuses to fill a
listing whose seller no longer owns or approves the token. The ERC-4626 vault is a composable
treasury primitive over Arc USDC — it runs no strategy and its `annualPercentageYieldBps()` returns
zero onchain, which the interface states plainly rather than dressing up as yield.

## What is autonomous?

The reward decision and its execution. The agent discovers the markets registered in the
factory and evaluates them autonomously on its bounded sweep, reads the
evidence itself, scores it, decides, derives the recipient and amount, mints its own execution
authority in-process, and signs the payout as the Circle Agent Wallet. A human can stop the whole
system with an emergency pause and can change the policy configuration — but there is no interface,
at any layer, through which a human approves, steers, redirects, or sizes an individual autonomous
payout. The HTTP surface has no vocabulary for it.

## What is live?

Everything described above, on Arc Public Testnet: deployed contracts, real USDC market trades,
real creator and treasury fees, a real media NFT sold between two distinct wallets for 0.250000
USDC, a real vault deposit and redemption, and two real autonomous creator payouts executed by the
Circle Agent Wallet and reconciled to VERIFIED against Arc events.

## What is not production-ready?

Testnet only, and stated on every screen. No independent security audit has been performed. Agent
spending caps are application-level, because Circle wallet-level spend limits are a mainnet
feature — the caps are transactionally enforced in PostgreSQL, but that is this application's own
control rather than the wallet's. Risk scoring detects onchain shape, not intent. The backend
collector uses a single Arc RPC and fails closed on outage. The Agent Wallet's CLI session is
time-bounded and the agent reports UNAVAILABLE when it lapses. Production hardening, key custody
review, monitoring, and a professional audit all remain open.

---

## Likely judge questions

**What is actually onchain?**
The token and its bonding market, the fee split, the media NFT with its market provenance and
content commitment, the NFT marketplace and its USDC settlement, the ERC-4626 vault, both
settlement contracts, and every creator payout. Policy evaluation, spend reservations, and the
audit trail are off-chain in PostgreSQL — but every decision they produce resolves to an Arc
transaction that can be verified without trusting the backend.

**Why does this need Arc?**
Because the whole economy is denominated in one asset that is also the gas. A bounded autonomous
spend policy — "at most 0.1 USDC per payout, 0.3 per market per day, 30 globally per day" — is only
expressible if the agent's budget, its payouts, and its transaction costs are the same unit. On a
chain with a separate volatile gas token the agent would need a second treasury, a price feed, and
a hedging policy before it could make a single bounded decision.

**Where is Circle used?**
USDC as the money. Agent Wallets as the autonomous executor. Developer-Controlled Wallets for the
separate human-authorized route and for deployment. Smart Contract Platform for every deployment.
Stablecoin Kits for live swap estimates. Webhooks for signature-verified settlement notifications.

**Is the agent actually autonomous?**
Yes, in the sense that matters: no human approves a payout. The recipient comes from
`market.creator()`, the amount from the decided score, the observation time from the Arc anchor
block, and the execution authority is minted in-process and bound to the evidence digest. A live
run recorded `operatorAddress: null` and `sessionId: null` on a payout that moved real USDC.

**Does a human approve autonomous payouts?**
No. A human can pause the system entirely and can configure the policy. The pause endpoint accepts
a boolean and a reason and nothing else — there is deliberately no field for a market, a recipient,
an amount, or an execution mode, so the transport offers no way to approve or steer one payout.

**Is this using an LLM?**
No. Not for the decision, not for the scoring, not anywhere in the payout path. The policy is
arithmetic over confirmed onchain trade data, versioned as `AGENT_AUTONOMOUS_POLICY_V1`. Calling it
AI would be a more impressive claim and a false one; a deterministic policy is also the only kind
you can safely give a wallet.

**How are agent spending limits enforced?**
Inside one PostgreSQL transaction holding an exclusive advisory lock, so the read of what is
already committed and the write that extends it cannot interleave. Two workers evaluating different
markets can no longer both observe an empty global budget. Caps are expressed in what the creator
receives, which is exactly what leaves the wallet.

**What prevents duplicate payouts?**
A primary key. One `(market, policy version, epoch)` row can exist, the epoch is derived from chain
time so every worker computes the same one independently, and the loser of the race is told who
won. The provider call additionally reuses a deterministic idempotency key, so a resumed attempt
replays the original Circle transaction rather than creating a second one.

**What happens if the Circle response is unknown?**
The budget stays held and the settlement is not marked failed. Capacity is returned only when a
failure is provably classified as pre-provider. Freeing budget on uncertainty is exactly how an
agent overspends during an incident. This bounds spending; it is not a delivery guarantee, and
nothing here claims exactly-once payment.

**Why doesn't the Agent Wallet use Memo?**
Because a Circle Agent Wallet is an ERC-4337 smart contract account and Arc's Memo `CallFrom`
extension only preserves a directly signing EOA as `msg.sender`. This was established empirically —
the wallet gained bytecode on first use, its first transaction went through the standard ERC-4337
EntryPoint via a bundler, and a Memo probe from it failed estimation. Rather than loosen the
settlement contract's immutable operator check, a second settlement contract was deployed with the
Agent Wallet as its operator, and the autonomous route calls it directly.

**Is the NFT content verified?**
The provenance is: the contract checks the market is registered in the trusted factory and that the
minter is its `creator()`. The content hash is the creator's onchain *commitment* to the media
bytes — the contract stores and de-duplicates it but cannot fetch a URL to check it. Anyone can
recompute the keccak256 digest from the file and compare. MemeVerse does not claim the contract
validates URL content.

**Does the vault generate yield?**
No. It runs no strategy, `annualPercentageYieldBps()` returns zero onchain, and the interface reads
that value from the contract rather than asserting it. It is a composable treasury primitive, not a
yield product.

**Is this mainnet ready?**
No, and nothing in the product says otherwise. Testnet only, no independent audit, application-level
rather than wallet-level spend limits.

**What would productionization require?**
An independent professional smart-contract audit. Wallet-level Circle spend limits, available on
mainnet, as a second enforcement layer under the application caps. A redundant Arc RPC for the
backend collector. Multi-operator support with role separation and a documented rotation procedure.
Environment-tunable metric targets, which are currently compile-time constants. Monitoring,
alerting, and backup/restore drills against managed PostgreSQL.

---

## Deck outline — 8 slides

Not built; provided so it can be produced quickly against the same facts.

1. **A meme becomes an economy.** The one-liner, the MemeVerse mark, "Built on Arc".
2. **The problem.** Creators generate the value and own nothing programmable.
3. **The product, in five steps.** Create → Trade → Own → Reward → Prove.
4. **The agent.** Economic actor, not a chatbot: wallet, budget, policy, cooldown. Screenshot of
   the Agent Command Center.
5. **The proof.** The reward receipt: 0.100000 USDC, Circle Agent Wallet, Arc tx, reconciliation
   VERIFIED, human approval NONE.
6. **How it stays safe.** Two isolated execution modes, atomic spend admission, primary-key
   cooldown, capacity never released on uncertainty.
7. **Why Arc and Circle.** One asset for money and gas; Agent Wallets as the executor.
8. **What is not ready.** Testnet, no audit, application-level caps — and what production requires.

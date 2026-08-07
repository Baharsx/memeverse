# MemeVerse — 3-minute demo script

The official submission asks for a **3-minute video pitch and demo covering core functionality and
use of Circle tools**. This is that three minutes, timeboxed, with the exact click at each moment.

Run `npm run demo:preflight` before recording. Do not start until it prints `DEMO READY`.

**Two rules, both non-negotiable:**

1. Never present a historical transaction as something that just happened. If the fallback is used,
   say the words *"a previously verified autonomous payout"* out loud.
2. Never claim mainnet, an audit, or exactly-once payment.

---

## 0:00 – 0:20 · Hook and problem

**Screen:** `/` — the homepage hero.

> "Meme culture creates enormous value and returns almost none of it to the people who make it.
> The creator owns nothing programmable — no asset, no claim on the activity their work generates.
> MemeVerse fixes that, and then automates the part that's always been manual."

**Click:** nothing yet. Let the hero read: *A MEME BECOMES AN ECONOMY.*

Scroll once, slowly, over the five-step strip: CREATE, TRADE, OWN, REWARD, PROVE.

> "Five steps. All of it real, all of it on Arc, all of it in USDC."

---

## 0:20 – 0:45 · Launch a real market

**Click:** `01 LAUNCH` in the navigation.

> "A creator deploys a real Arc contract from their own wallet — a fixed-supply token and its USDC
> bonding market, through an immutable factory."

**Screen:** point at the review panel — creator, factory address, base price, and the creator and
treasury fee percentages read live from the factory contract.

> "Nothing here is a form that emails somebody. This is a contract deployment, and the success
> state only appears after Arc includes it in a final block."

*(If a market was launched during preparation, the NEXT STEP hand-off is already on screen — use
it. Otherwise click `02 MARKETS`.)*

---

## 0:45 – 1:15 · USDC trading and creator economics

**Screen:** `/markets`, with a market selected.

> "This is live chain state. Curve reserve, supply sold, spot quote — all read from the market
> contract, not from a database."

**Click:** the BUY tab, leave the default amount.

> "The quote breaks the trade apart: what the curve costs, what the creator gets, what the treasury
> gets. Those splits happen inside the same transaction as the trade. The creator earns from
> activity, not from a payout schedule."

**Scroll down** to the CREATOR ECONOMY panel.

> "And this is the creator's actual position across the whole economy right now — market reserve,
> fees the market has paid them, their media NFTs, and any autonomous rewards. Current onchain
> state, not an estimated lifetime total."

---

## 1:15 – 1:40 · Media provenance

**Click:** the NEXT STEP card — *MINT CREATOR MEDIA*.

**Screen:** `/nft`.

> "Creators mint media only against markets they actually created. The contract checks that
> provenance onchain — it verifies the market is registered in the trusted factory and that you are
> its creator. That cannot be forged from the browser."

**Point at** a card's MARKET, CREATOR, OWNER, and CONTENT HASH rows.

> "The content hash is the creator's onchain commitment to the file bytes. The contract stores and
> de-duplicates it; anyone can recompute the digest from the file and compare. We don't claim the
> contract fetches the URL — it can't, and saying otherwise would be a lie."

**Point at** a listing.

> "And it trades for USDC. This one sold between two separate wallets for exactly 0.25 USDC."

---

## 1:40 – 2:30 · The autonomous agent — the centerpiece

**Click:** the NEXT STEP card — *WATCH AUTONOMOUS REWARDS*.

**Screen:** `/agent` — the Agent Command Center.

> "This is an economic actor. It observes, decides, pays, and proves — on its own."

**Point at** the status block, top-right, then the fact grid.

> "It has a Circle Agent Wallet — an ERC-4337 smart account backed by MPC, created with Circle's
> own CLI. There's no private key in this codebase. It has a daily budget, and this is how much of
> it is actually left today, read from the same ledger the spend gate admits against."

**Scroll to** WHAT THE POLICY ACTUALLY CHECKS.

> "The policy is arithmetic over confirmed Arc trades: engagement, retention, liquidity, risk, and
> how complete the log scan was. Gates and caps on the right. Every one of those is enforced
> server-side, and the agent derives its own recipient from `market.creator()` and its own amount
> from the score. No browser request can choose either."

**Scroll to** the DECISION TIMELINE.

> "Here are its real decisions. This market: twelve trades, two distinct traders, over this block
> range. Score 100. Decision: REWARD. Creator payout, 0.1 USDC. Human approval — **none**."

**If autonomy is running and a live payout lands, show it.** Otherwise, point at the top entry and
say:

> "This is a **previously verified autonomous payout**, from a live run. Same agent, same wallet,
> same policy."

---

## 2:30 – 2:50 · Proof on Arc

**Scroll up** to the AUTONOMOUS REWARD RECEIPT, or **click** the NEXT STEP card to `/safety`.

> "Every autonomous payout reduces to this receipt: decision, policy version, market, creator,
> payout, executor, Arc transaction, settlement contract — and reconciliation VERIFIED."

**Click** the ARC TX link. **Screen:** ArcScan, in a second tab that is already open.

> "That's the transaction. The `SettlementExecuted` event and the USDC transfer both agree with
> what the receipt claims, and reconciliation takes the expected operator from configuration — not
> from the event it's verifying."

**Click** back to `/safety`, scroll to LIMITATIONS.

> "And this is what we don't claim. Testnet only. No independent audit. Not mainnet ready. The
> agent's spending caps are enforced by our database, not by the wallet, because wallet-level
> limits are a mainnet feature. We'd rather you know that than find it."

---

## 2:50 – 3:00 · Close

**Screen:** back to `/` or hold on the Proof Center.

> "A meme becomes an economy. The economy runs in USDC on Arc. A Circle Agent Wallet participates
> in it autonomously. And every step of it can be verified without trusting us."

---

## Fallback paths

Rehearse these. Something will be slow.

| If this happens | Do this | Say this |
| --- | --- | --- |
| **Wallet is slow to connect** | Skip signing. Every read surface renders without a wallet. | "I'll skip the wallet — all of this reads from the chain regardless." |
| **Arc RPC is slow or rate-limits** | Move to `/agent`, which reads the backend rather than the RPC. Use the ArcScan tab you already have open. | "Public RPC is throttling the browser; here's the same state from ArcScan." |
| **A live transaction won't confirm in time** | Do not wait. Move on and return to the receipt. | "That'll confirm in the background — here's a completed one." |
| **The agent doesn't trigger during the demo** | Show the top DECISION TIMELINE entry and its receipt. | **"This is a previously verified autonomous payout."** Never "watch it happen now." |
| **The Agent Wallet session has lapsed** | The status reads UNAVAILABLE. Show it, then show the historical receipt. | "The Agent Wallet's session is time-bounded and this one has expired — the agent reports unavailable and stops paying rather than guessing. Here's a payout from when it was live." |
| **Backend is unreachable** | Every page states it explicitly. Use `/markets` and `/nft`, which read Arc directly. | "The API is down, and the interface says so instead of showing stale numbers. The chain reads still work." |
| **You are out of time at 2:30** | Cut the vault and quote surfaces entirely; they are not in this script. Land the receipt. | — |

## Circle-tools coverage checklist for the video

The official criteria ask the video to cover the use of Circle tools. Confirm each is said aloud:

- [ ] **USDC on Arc** — named at 0:20 and 0:45
- [ ] **Circle Agent Wallet** — named at 1:40, with "ERC-4337 smart account, MPC, no private key"
- [ ] **Developer-Controlled Wallet** — named when contrasting the two execution modes at 2:30
- [ ] **Circle Smart Contract Platform** — one line: "every contract here was deployed through it"
- [ ] **Circle Stablecoin Kits** — optional, `/quote`, only if time remains

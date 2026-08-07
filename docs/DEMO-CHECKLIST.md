# MemeVerse — demo checklist

Work backwards from the moment the recording starts. Every item is checkable; nothing here asks
you to trust that something is probably fine.

---

## 24 hours before

**Funding**

- [ ] Presenting wallet holds **≥ 5 USDC** on Arc Testnet (<https://faucet.circle.com/>). A launch,
      an approval, two trades, and a mint cost gas plus principal.
- [ ] **Circle Agent Wallet** `0x65da73c6…0FE3` holds **≥ 2 USDC**. `npm run demo:preflight` reports
      the balance; the Agent Command Center shows it as AGENT WALLET USDC.
- [ ] Developer-Controlled Wallet `0x6bbD385C…b689` funded, if the manual route will be shown.

**Sessions and credentials**

- [ ] `circle` CLI session is valid. The Agent Command Center must show **STATUS: ACTIVE** and
      wallet state **LIVE**. A lapsed session reads UNAVAILABLE and the agent will not pay.
      Sessions are time-bounded (~28 days) — renewing takes a human login, so do it now, not on
      the day.
- [ ] `.env.local` present and complete. `npm run demo:preflight` shows CONFIGURED for the Agent
      Wallet, Circle credentials, and Kit Key.

**System**

- [ ] `npm ci && NODE_ENV=test npm test` — 313 pass (259 backend, 54 contract).
- [ ] `NODE_ENV=production npm run build` — succeeds, no chunk over 500 kB.
- [ ] `npm run db:migrate` has been run against the demo database.
- [ ] `npm run demo:preflight` — **DEMO READY**, or the only warnings are ones you have decided to
      accept.

**Content**

- [ ] At least **two live markets** exist with real trade history, so `/markets` is not empty.
- [ ] At least **one media NFT** is minted and one is **listed for USDC**, so `/nft` shows both
      states.
- [ ] At least **one verified autonomous payout** is in the decision timeline. This is the
      fallback, and it must exist before you need it.

**Recording**

- [ ] `docs/DEMO-SCRIPT.md` rehearsed end to end, timed. Under 3:00 with ten seconds of slack.
- [ ] A backup screen recording of the full path exists, in case the live run fails entirely.

---

## 1 hour before

- [ ] `npm run demo:preflight` again. Arc block height should have moved since yesterday.
- [ ] API running: `npm run dev:api` (or `start:api`). `curl localhost:8787/api/health` returns
      `"status":"ok"` and `"arc":{"status":"verified"}`.
- [ ] Worker running: `npm run dev:worker` (or `start:worker`). Its startup log must show
      `"autonomousAgent":{"enabled":true}` — if it says `AGENT_AUTONOMOUS_ENABLED_FALSE` or
      `AGENT_WALLET_NOT_CONFIGURED`, the agent will not evaluate anything.
- [ ] Frontend running and reachable at the URL you will actually present from.
- [ ] **Autonomy is unpaused.** The Agent Command Center must read ACTIVE, not PAUSED. The
      committed default is paused as a fail-safe; an operator has to turn it on.
- [ ] PostgreSQL reachable. Preflight reports the epoch count.

---

## 10 minutes before

**Browser**

- [ ] Clean profile or a fresh window. No extension popups, no unrelated tabs, no bookmarks bar
      full of other projects.
- [ ] Wallet extension unlocked, connected to **Arc Public Testnet, chain 5042002**, on the
      presenting account.
- [ ] Zoom at **100%**. Window at **1440×900** or **1920×1080** — the layout is verified at both.
- [ ] Notifications silenced. Do not disturb on.

**Tabs, in this order**

1. MemeVerse `/` — the tab you present from
2. ArcScan on the fallback autonomous payout:
   `https://testnet.arcscan.app/tx/0xffad62e616262a682dcfd0ac85a7ced9f7b16290b29beadec6225e008c6b6799`
3. ArcScan on the Agent Wallet:
   `https://testnet.arcscan.app/address/0x65da73c6d9300F3dAb1dF785219f76DeCA5e0FE3`
4. ArcScan on the autonomous settlement contract:
   `https://testnet.arcscan.app/address/0x2176107C2562Ed30ca1d490C43cD53C3369946e2`

**Final visual sweep** — load each and confirm it renders, then return to `/`:

- [ ] `/` — hero, five-step strip, six runtime cards. No card reads UNAVAILABLE that you cannot
      explain.
- [ ] `/markets` — a market is selected and the creator economy panel has numbers.
- [ ] `/nft` — at least one card with an image; a listing is visible.
- [ ] `/agent` — **STATUS: ACTIVE**, the reward receipt is present, the timeline has entries.
- [ ] `/safety` — server and browser head blocks agree within a block or two; every contract row
      shows an address rather than NOT CONFIGURED.

---

## During the demo

- [ ] Refresh `/agent` before starting, so the status is current rather than fifteen minutes stale.
- [ ] Do **not** wait on an unconfirmed transaction. Move on; come back to it.
- [ ] If you show a historical payout, say **"a previously verified autonomous payout."** Out loud.
- [ ] Do not claim mainnet, an independent audit, or exactly-once payment.
- [ ] Land the receipt. If you only get one thing on screen, make it the AUTONOMOUS REWARD RECEIPT
      with RECONCILIATION VERIFIED and HUMAN APPROVAL NONE.

---

## After

- [ ] Re-pause autonomy if the deployment will be left running unattended.
- [ ] Record any Arc transaction hashes produced live — they are additional proof for the written
      submission.
- [ ] Update `docs/SUBMISSION.md` with the demo URL if the application was hosted for the session.

# Stage 3 — judge-ready autonomous economy

Stage 2 closed with a technically complete system: real Arc markets, real USDC, real media
provenance, a real vault, and a genuinely autonomous creator-settlement agent executing through a
Circle Agent Wallet. What it did not have was a way for somebody with three minutes to understand
any of that.

Stage 3 is productization, not scope expansion. No contract was redeployed, no ABI changed, no
settlement semantics moved, and no trust boundary was relaxed. What changed is what a visitor
sees, what the agent is willing to say about itself, and whether a demo can be rehearsed.

Baseline: `a72bcf244237c1bb310b082f913ca16fb557a73f`.

---

## 1. What Stage 3 changed

| Area | Change |
| --- | --- |
| Home page | Rewritten around the product story rather than the engineering loop |
| Navigation | Reordered to the demo path; every surface hands off to the next |
| `/agent` | New Agent Command Center — status, wallet, budget, policy, decision timeline, reward receipt |
| `/safety` | Became the Proof Center — live network, contracts, execution modes, executor, trust boundary, limitations |
| `/markets` | Added a creator economy panel showing one creator's position across every layer |
| `/nft`, `/vault` | Reframed for comprehension; media URL handling hardened |
| Agent status API | Additive, sanitized: daily budget, last evaluation, settlement contract, policy version, reference |
| Demo tooling | `npm run demo:preflight` — read-only readiness check |
| Documentation | Submission package, 3-minute script, demo checklist |
| Tests | +22 backend (237 → 259). Contract tests unchanged at 54. |

### What did **not** change

Deployed Solidity, ABIs, contract addresses, the Agent Wallet architecture, the manual
Developer-Controlled Wallet route, autonomous settlement semantics, the Memo/manual separation, the
Agent Wallet/direct-autonomous separation, atomic global and per-market spend reservations, the
`UNKNOWN_OUTCOME` capacity hold, `PRE_PROVIDER` release semantics, provider idempotency, execution
claim ownership, the reconciliation trust model, ERC-4337 bundler handling, the PostgreSQL state
model, deployment artifacts, or the database schema.

`contracts/`, `contracts/artifacts/`, and every `scripts/circle-deploy-*.js` are byte-identical to
the Stage 2 baseline.

---

## 2. The one judged path

```
/launch  →  /markets  →  /nft  →  /agent  →  /safety
CREATE      TRADE         OWN      REWARD     PROVE
```

Navigation is ordered to match. *(Superseded after Stage 3: each surface originally ended in a
`NextStep` hand-off card. Once the homepage gained its Three-Minute Tour those cards were
repetitive, so they were removed from every inner route and the guided journey now lives on the
homepage alone.)*

The home page opens with the sentence the whole product reduces to — *A MEME BECOMES AN ECONOMY* —
followed by the five steps as clickable cards, then six runtime cards each stating something the
server or the browser actually verified.

---

## 3. Agent Command Center

The single most important judging surface, rebuilt around one claim: **this is an economic actor,
not a chatbot.** There is no chat box, no simulated reasoning, and no language model anywhere in
the payout path.

**Header** — status resolved from three independent facts rather than one flag:

| Reported | When |
| --- | --- |
| `ACTIVE` | Agent Wallet configured, session LIVE, autonomy unpaused |
| `PAUSED` | Configured and healthy, but an operator engaged the emergency stop |
| `UNAVAILABLE` | No Agent Wallet configured, or its session has lapsed |

A paused agent is not reported as unavailable. It has been deliberately stopped, and that is a
different fact.

**Facts grid** — Agent Wallet address (ArcScan-linked), account type, network, wallet USDC balance,
daily budget used against cap, available today, policy version, last evaluation timestamp, last
payout, and the autonomous settlement contract. Anything the backend cannot answer reads
`NOT CONFIGURED` or `UNAVAILABLE`. Nothing is illustrated with an example value.

**Policy card** — the five signals the collector actually derives, and the eight gates actually
enforced, read from the live policy rather than transcribed into the interface.

**Decision timeline** — every recent epoch as a judge-readable decision:

```
MARKET      $SYMBOL, ArcScan-linked
DECISION    REWARD | NO PAYOUT | IN PROGRESS
WHY         POLICY_PASS or the real reason code
AMOUNT      creator payout in USDC
EXECUTOR    CIRCLE AGENT WALLET
OBSERVED    provenance, block window, trades, traders, score
APPROVAL    NONE
STATUS      VERIFIED | PENDING | DENIED | FAILED
ARC TX      real hash, ArcScan-linked
```

**Reward receipt** — rendered only for a payout with outcome `EXECUTED` *and* a real transaction
hash. A pending or denied decision has no receipt. That guard is asserted directly in the test
suite, because rendering a receipt for a payout that never happened would be the single most
misleading thing this page could do.

---

## 4. Proof Center

`/safety` became the page a sceptic reads.

- **Live network** — chain ID, the API server's verified head block, and *the browser's own* head
  block read independently against the public Arc RPC. Two independent reads of the same chain
  that a visitor can watch agree.
- **Deployed contracts** — full addresses, not truncations, each ArcScan-linked, with its role.
- **Two isolated execution modes** — `MANUAL_OPERATOR` beside `AUTONOMOUS_POLICY`, showing account
  type, routing, authorization, and whether a human approves each payout.
- **Autonomous executor** — the Agent Wallet, its state, and the latest verified reward receipt.
- **Trust boundary** — five sentences on what actually prevents misuse.
- **Limitations** — Arc Public Testnet MVP and not mainnet-ready, no independent audit,
  application-level caps, deterministic policy with no LLM, heuristic risk scoring, expiring wallet
  session. In red, at the bottom, unavoidable.

---

## 5. Backend changes

Two files, both additive.

### `AutonomousAgentService.status()`

New fields on the existing sanitized public endpoint:

| Field | Source | Why it is safe |
| --- | --- | --- |
| `budget` | `AgentAutonomyStore.dailySpendState()` | Aggregate USDC figures over the agent's own reservation ledger. Policy constants and sums, no identities. |
| `lastEvaluationAt` | most recent epoch claim | A timestamp already implied by `recentEpochs` |
| `settlementContract` | configuration | A public deployed Arc address |
| `policyVersion` per epoch | epoch row | A policy constant |
| `reference` per epoch | settlement record | Server-generated `AUTONOMOUS <SYMBOL> EPOCH <n>`; no caller can write into this path |

`budget` reports `committed` capacity — reserved *and* consumed — because a payout still holding a
reservation is not spent yet but is not available either. Reporting it as free would be a status
page talking an operator into overspending. When the ledger cannot be read the field reports
`available: false` rather than an empty budget.

Nothing else moved. No settlement semantics, no policy behaviour, no execution path.

### Content Security Policy

`img-src` gained `https:`.

Media NFT artwork is minted by users and lives on hosts MemeVerse does not control, so an origin
allowlist cannot express the gallery, and the previous `'self' data:` policy silently blocked every
real minted image. `https:` is scheme-restricted rather than a wildcard, images cannot execute
script, and `referrerPolicy: no-referrer` keeps the visited URL from leaking to the image host.

The browser additionally refuses any media URL that is not plain `https:` or a `data:image/…`
payload, so a hostile `javascript:`, `blob:`, or `data:text/html` token URI never reaches an
attribute. `script-src`, `object-src`, `frame-ancestors`, and `connect-src` are unchanged, and a
test asserts no directive carries a wildcard.

Separately, `frame-ancestors` is now stripped from the `<meta>`-delivered copy of the policy: the
specification defines it as ignored there, so shipping it bought nothing and logged a console
warning on every page load. The API response header — and its matching `X-Frame-Options: DENY` —
are unchanged.

---

## 6. Demo preflight

```bash
npm run demo:preflight
```

Read-only. No transaction, no deployment, no funding call, no privileged execution, no DDL. A test
asserts the script contains no write primitive and no `INSERT`/`UPDATE`/`DELETE`.

It checks the Arc RPC and its fallback (chain ID and head block), bytecode presence for every
contract on the demo path, Agent Wallet and Circle credential configuration, autonomous worker
configuration, frontend `VITE_` addresses, PostgreSQL reachability, backend health, and whether the
two known historical autonomous payouts are still readable on Arc.

Credentials are reported as `CONFIGURED` / `NOT CONFIGURED`. No value is ever read into the output —
a preflight is exactly the kind of thing somebody pastes into a chat window ten minutes before a
demo.

Verdict: any `FAIL` yields `NOT READY`; any `WARN` yields `READY WITH WARNINGS`; otherwise
`DEMO READY`.

---

## 7. Deployment readiness

The repository has one deployment target and Stage 3 did not invent another. `ops/systemd/` carries
hardened unit files for the API and the worker as separately supervised services; `README.md`
documents the same-origin reverse-proxy topology, the migration identity split, and the environment
separation.

Required topology, unchanged:

```
static frontend  +  Express API  +  autonomous worker  +  PostgreSQL  +  Arc RPC  +  Circle credentials
```

The worker runs as its own process. Only `VITE_*` values reach the browser; Circle credentials, the
database URL, operator configuration, Agent Wallet configuration, and policy configuration are
server-only.

Two Stage 3 additions:

- `VITE_BASE_PATH` makes the build's base path configurable. The committed default is `/memeverse/`,
  which is what the project has always deployed to; a root-domain deployment sets `/`. The router
  derives its basename from the same value, so the two cannot disagree.
- `vite preview` now proxies `/api` the way the dev server does, so the production bundle can be
  smoke-tested against a real API on one origin — which is what the `SameSite=Strict` operator
  cookie requires.

**Deep links.** All eight routes render on direct navigation, verified in a real browser against
the production build. This needs SPA history fallback at the edge — `vite preview` provides it;
a reverse proxy must too:

```nginx
location /memeverse/ {
  alias /opt/memeverse/dist/;
  try_files $uri $uri/ /memeverse/index.html;

  # The static document does not inherit the API's security headers.
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "no-referrer" always;
  # frame-ancestors only: the full CSP travels in the built document's meta tag, and this is the
  # one directive a browser is defined to ignore there. A second full copy would only drift.
  add_header Content-Security-Policy "frame-ancestors 'none';" always;
}
location /api/ {
  proxy_pass http://127.0.0.1:8787;
}
```

`add_header` does not merge across levels — a block declaring any `add_header` drops every
inherited one — so these belong in the `location` that serves the frontend.

**No public host has been chosen.** Provisioning one is a human decision and Stage 3 did not make
it. See `docs/SUBMISSION.md`.

---

## 8. Verification

| Check | Result |
| --- | --- |
| `NODE_ENV=test npm test` — backend | **259 pass**, 0 fail (baseline 237) |
| `NODE_ENV=test npm test` — contracts | **54 pass**, 0 fail (unchanged) |
| `NODE_ENV=production npm run build` | Success, largest chunk 268.62 kB, no chunk-size warning |
| `npm audit` | **0 vulnerabilities** |
| `git diff --check` | Clean |
| `npm run contracts:audit:onchain` | Runtime bytecode matches local artifacts |
| `npm run markets:audit:onchain` | Factory and markets verified |
| `npm run assets:audit:onchain` | Media, marketplace, and vault verified |
| `npm run demo:preflight` | Every contract and both proof transactions readable |
| GitHub Actions, run `31156905735`, job `92798273291` | **success** on checkout SHA `eadbf33b713978372b1aacbc05f42f55faa3752a` — 259 backend + 54 contract tests under `NODE_ENV=test`, production build under `NODE_ENV=production`, `npm audit` 0, no chunk-size warning |

**Production bundle**, configured local build:

| Chunk | Raw | Gzip |
| --- | --- | --- |
| `chain` (viem, noble, scure) | 268.62 kB | 82.75 kB |
| `react` | 192.49 kB | 60.35 kB |
| `wallet` (wagmi, tanstack) | 68.14 kB | 20.36 kB |
| `index` (application) | 61.78 kB | 18.11 kB |
| `stage3-views` | 22.59 kB | 6.91 kB |
| `stage2-views` | 14.50 kB | 4.92 kB |
| `vendor` | 5.38 kB | 2.16 kB |
| CSS | 53.44 kB | 9.57 kB |

Nothing exceeds 500 kB. The Stage 3 surfaces are their own lazily loaded chunk and are not paid for
by a visitor who only opens the markets page.

**A note on bundle numbers.** A configured local build and a clean unconfigured CI build differ,
because Vite inlines `VITE_*` contract addresses at build time. Measured on this exact commit: the
local configured application chunk is **61.78 kB**, CI's is **61.57 kB**, and every other chunk —
including the CSS — is byte-identical. Both are correct; they measure different builds. Always name
the environment a bundle figure came from.

### Real browser QA

Production build, served through `vite preview` with the API proxied on one origin, driven by
headless Chromium across **8 routes × 4 viewports = 32 combinations** (1920×1080, 1280×800, 768,
390). Every combination clean: no uncaught exception, no runtime or hydration error, no failed
import, no 404 asset, no horizontal overflow, and a rendered heading on every page.

---

## 9. Security review of Stage 3 changes

| Concern | Finding |
| --- | --- |
| XSS via NFT metadata URL | **Fixed.** `safeMediaUrl()` admits only `https:` and `data:image/…`; 18 hostile inputs are asserted refused. |
| XSS via metadata name/description | React escapes text nodes; no `dangerouslySetInnerHTML` exists anywhere in `src/`. |
| External link safety | Every `target="_blank"` carries `rel="noreferrer noopener"`, asserted by test. |
| New public endpoint | None added. The existing sanitized `/api/v1/agent/autonomy` gained aggregate figures and public Arc addresses only. |
| Secret exposure | Asserted absent: Circle transaction IDs, wallet IDs, worker identity, API key, entity secret. |
| Auth regressions | No auth code touched. Privileged routes, operator session, and execution authorization are unchanged. |
| CORS / origin checks | Unchanged. |
| Rate limits | Unchanged. The agent status endpoint remains on the global bucket. |
| SQL safety | No new query. `dailySpendState()` is pre-existing and fully parameterized. |
| Address / amount formatting | Formatted from exact integer units throughout; no float arithmetic on money. |
| Stale data | Every surface reports its own unavailability rather than rendering a cached figure. |
| Fake success | The proof receipt cannot render without `EXECUTED` *and* a transaction hash. |
| Privileged browser config | Only `VITE_*` public addresses reach the bundle. |
| Autonomous/manual boundary | Untouched. Both remain isolated by wallet, contract, and allowance. |
| CSP | `img-src` widened to `https:` — deliberate, documented in §5, with client-side scheme enforcement in front of it. Everything executable stays `'self'`. |

---

## 10. Known limitations

Unchanged from Stage 2, and now stated on the Proof Center itself rather than only in
documentation:

1. Arc Public Testnet only. Test assets have no real-world value.
2. No independent security audit.
3. Not production ready.
4. Agent spending caps are application-level; Circle wallet-level limits are a mainnet feature.
5. The policy is deterministic arithmetic, not intelligence.
6. `fraudRisk` detects onchain shape, not intent.
7. Metric targets are compile-time constants, not environment-tunable.
8. A single Arc RPC backs the backend collector; it fails closed on outage.
9. The Agent Wallet CLI session is time-bounded and needs a human to renew.
10. An undetermined payout holds budget for the rest of the UTC day. That is the safe direction.

New to Stage 3:

11. ~~No public demo host.~~ **Resolved after Stage 3**: the application is deployed and publicly
    reachable at <https://memeverse.biz>.
12. **No submission deck.** An outline exists in `docs/SUBMISSION.md`; the deck itself is a human
    action item.

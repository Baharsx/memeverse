# MemeVerse

**MemeVerse is a meme asset terminal built on Arc Network for launching, trading, minting, and autonomously preparing creator settlement in USDC.**

The current release is a public Testnet MVP. Launch, trade, and NFT screens remain simulations. The Agent screen now uses a real local backend to enforce policy, create expiring settlement quotes, persist records, and prepare a non-broadcast execution plan. No flow signs or broadcasts a transaction yet.

## Built on Arc

MemeVerse is an independent product. The MemeVerse name and visual identity lead; Arc is the stablecoin infrastructure underneath it.

The product explores two Arc ecosystem tracks:

- **DeFi:** USDC-denominated meme markets, bonding curves, treasury controls, creator revenue splits, and conditional settlement.
- **Agentic economy:** transparent policy evaluation, capped allocation, reconciliation references, explicit transaction states, and non-custodial settlement preparation.

## Current MVP

- Arc Testnet wallet connection and network switching through wagmi
- Centralized Arc RPC, explorer, official links, and contract registry
- Express settlement API with Arc RPC chain verification and structured errors
- Server-enforced USDC spend/virality policy using exact six-decimal integer math
- Durable JSON settlement records written atomically with `0600` permissions
- Idempotent quote creation, five-minute expiry, and explicit transaction state transitions
- Browser Agent flow connected to `quote → prepare → persisted record`
- USDC-native gas and settlement presentation
- Meme-token launch, bonding-curve trade, NFT archive, vault, and agent simulations
- Reconciliation reference and deterministic `bytes32` Memo ID generation
- Explicit simulation receipts that distinguish preparation from broadcast and settlement
- Safety center with verified Arc resources, contract links, and transaction lifecycle
- Responsive tactile-brutalist interface

## Arc Testnet configuration

MemeVerse uses only parameters currently published in the official Arc documentation. No mainnet RPC, chain ID, or contract address will be added until Arc publishes it through official documentation.

| Property | Value |
|---|---|
| Chain ID | `5042002` |
| Native gas | USDC |
| RPC | `https://rpc.testnet.arc.io` |
| WebSocket | `wss://rpc.testnet.arc.io` |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com/` |
| Finality handling | 1 confirmed block |

The public RPC can be overridden for local development:

```bash
cp .env.example .env
```

Only public browser configuration may use a `VITE_*` variable. Never place private keys or privileged Circle credentials in a Vite environment variable.

## Verified Testnet contracts

| Contract | Address | Purpose |
|---|---|---|
| USDC ERC-20 interface | `0x3600000000000000000000000000000000000000` | Six-decimal USDC transfers and allowances |
| Memo | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` | Reconciliation metadata around a contract call |
| Multicall3From | `0x522fAf9A91c41c443c66765030741e4AaCe147D0` | Batched calls with original EOA sender preservation |

Addresses must be rechecked against the [official Arc contract registry](https://docs.arc.io/arc/references/contract-addresses) before deployment.

## Phase 1 architecture

```text
Agent form → Settlement API → Policy engine → State machine → JSON store
                    ↓
             Arc RPC chain health
```

The backend is the authority for policy and quote state. Browser inputs never define policy limits. The execution plan names a `CIRCLE_AGENT_WALLET_PHASE_2` provider boundary but contains no Circle credential, private key, signing call, or broadcast path.

### Settlement API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | Verify API availability, Arc Chain ID, and current block |
| `GET` | `/api/v1/config` | Return public network and policy settings |
| `POST` | `/api/v1/settlements/quote` | Enforce policy and persist an approved or denied decision |
| `POST` | `/api/v1/settlements/:id/prepare` | Move an approved live quote to `AWAITING_SIGNATURE` |
| `GET` | `/api/v1/settlements/:id` | Read one settlement and lazily apply expiry |
| `GET` | `/api/v1/settlements` | List persisted settlements |

`POST /quote` requires an `Idempotency-Key` header between 8 and 128 characters. Reusing the same key and body returns the original record; reusing it with a different body returns HTTP `409`.

## Transaction and reconciliation model

The settlement backend recognizes these application states:

1. `PREPARED` or `DENIED`
2. `AWAITING_SIGNATURE`
3. Circle-compatible asynchronous states: `INITIATED`, `QUEUED`, `CLEARED`, `SENT`, `STUCK`
4. `CONFIRMED`, then `COMPLETE`
5. Terminal recovery states: `EXPIRED`, `CANCELLED`, `FAILED`

The application must persist the client reference, Memo ID, latest transaction hash, chain ID, expected contract and failure class. A hash alone is not proof of success; settlement requires a successful receipt and expected events.

Blind retries are forbidden. A pre-broadcast rejection may be safely retried after user action. An unknown or post-broadcast failure must first be reconciled by transaction hash and reference to avoid duplicate execution.

### Transaction Memo guardrails

- Memo is Testnet infrastructure, not a claim that current MemeVerse simulations are onchain.
- The direct caller must be an externally owned account (EOA).
- Smart contract accounts, ERC-4337 wallets, Safe, and intermediary contracts are not supported as direct callers.
- Memo events are indexed by `memoId`, sender, and target; the original calldata should be retained when exact call reconstruction is required.
- Memo formats and indexer queries must be tested end to end before production use.

### Batched transaction guardrails

- Multicall3From also requires a direct EOA caller.
- `allowFailure` must be selected deliberately for each call.
- Atomic financial operations use `allowFailure: false`; partial execution is allowed only when the product explicitly reconciles each failed subcall.
- Success is verified from the target contract events because Multicall3From does not emit a batch-specific success event.

## Circle integration boundary

Circle Stablecoin Kits, Gateway, Unified Balance, Agent Wallets, and webhooks are roadmap dependencies, not installed capabilities in this repository. Phase 1 deliberately enforces its own server policy because Circle Agent Wallet spending policies are not currently available on Testnet.

Before adding them:

- model confirmed, pending inbound, and funds-in-motion balances separately;
- validate route readiness and fee assumptions before execution;
- persist the latest onchain hash through broadcast callbacks;
- authenticate Gateway webhooks and deduplicate at-least-once delivery by notification ID;
- distinguish recoverable mint-side failures from permanent validation failures;
- make telemetry opt-in/opt-out behavior an explicit product decision and never send wallet addresses, transaction data, stack traces, or secrets unintentionally.

## Security posture

See [SECURITY.md](./SECURITY.md). The product links only to official Arc documentation, status, faucet, and explorer resources. MemeVerse support will never request a seed phrase, private key, wallet backup, or one-time code.

Arc post-quantum capabilities are currently a roadmap. MemeVerse does not claim post-quantum protection today. Future wallet and custody architecture must remain migration-ready and follow the [official Arc post-quantum documentation](https://docs.arc.io/arc/concepts/post-quantum-security).

## Arc Brand compliance

- Public copy uses descriptive language such as **Built on Arc**, **Available on Arc**, or **Deploy on Arc**.
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

Vite proxies `/api` in development. The backend writes records to `.data/settlements.json`, which is intentionally ignored by Git. Copy `.env.example` to `.env` to override public and server-only configuration.

Run each process separately when needed:

```bash
npm run dev:api
npm run dev:web
```

## Production build

```bash
npm run build
npm run preview
```

## Next implementation milestone — Phase 2

- Add Circle Developer-Controlled or Agent Wallet credentials only to the backend
- Create and fund an Arc Testnet wallet through the official Circle integration
- Replace the Phase 1 adapter plan with a signed Testnet USDC execution
- Persist Circle transaction IDs and asynchronous state changes
- Authenticate and deduplicate Circle webhook notifications
- Reconcile confirmed receipts and expected events before marking `COMPLETE`

## License

MIT

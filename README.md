# MemeVerse

**MemeVerse is a meme asset terminal built on Arc Network for launching, trading, minting, and autonomously preparing creator settlement in USDC.**

The current release is a public Arc Testnet MVP. Launch, trade, and NFT screens remain simulations. The Agent screen enforces policy in a real backend, reserves treasury capacity transactionally, and can submit an explicitly approved creator payout through Arc Memo and the verified MemeVerseSettlement contract using a Circle Developer-Controlled EOA. The default unconfigured environment cannot sign or broadcast.

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
- Durable transactional PostgreSQL/PGlite settlement records
- Idempotent quote creation, five-minute expiry, and explicit transaction state transitions
- Browser Agent flow connected to `quote → prepare → persisted record`
- Official Circle Developer-Controlled Wallets SDK integration for Arc Testnet USDC
- Explicit `prepare → execute → reconcile` flow; no automatic or hidden signing
- Signed Circle webhook verification with durable `notificationId` deduplication
- Circle wallet readiness and USDC balance endpoint without secret exposure
- Verified MemeVerseSettlement contract deployed on Arc Testnet
- Direct EOA Arc Memo execution with persisted calldata and calldata hash
- Independent Memo, SettlementExecuted, and USDC Transfer event reconciliation
- Transactional treasury reservations that prevent concurrent overspend
- Durable reconciliation worker for submitted Circle transactions
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

Addresses must be rechecked against the [official Arc contract registry](https://docs.arc.io/arc/references/contract-addresses) before deployment.

## Phase 3 architecture

```text
Agent form → Settlement API → Policy + treasury reservation
                    ↓                     ↓
       PostgreSQL transaction       Circle EOA signer
                    ↓                     ↓
             State machine ← Arc Memo → MemeVerseSettlement
                    ↑                     ↓
        Poll / signed webhook   Memo + settlement + USDC events
                    ↑                     ↓
              Durable reconciliation worker / Arc indexer
```

The backend remains the authority for policy, recipient, amount, chain, expiry, and allowed state transitions. Circle credentials and the entity secret never enter the Vite bundle. The Circle SDK produces a unique entity-secret ciphertext for each authorized request and Circle receives the settlement UUID as its idempotency key.

### Settlement API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | Verify API availability, Arc Chain ID, and current block |
| `GET` | `/api/v1/config` | Return public network and policy settings |
| `POST` | `/api/v1/settlements/quote` | Enforce policy and persist an approved or denied decision |
| `POST` | `/api/v1/settlements/:id/prepare` | Move an approved live quote to `AWAITING_SIGNATURE` |
| `POST` | `/api/v1/settlements/:id/execute` | Explicitly authorize and submit the Arc Memo contract call to Circle |
| `POST` | `/api/v1/settlements/:id/reconcile` | Compare Circle state with the final Arc receipt and expected events |
| `GET` | `/api/v1/settlements/:id` | Read one settlement and lazily apply expiry |
| `GET` | `/api/v1/settlements` | List persisted settlements |
| `GET` | `/api/v1/circle/wallet` | Check configured EOA state and Arc Testnet USDC balance |
| `POST` | `/api/webhooks/circle` | Verify and consume signed `transactions.outbound` notifications |

`POST /quote` requires an `Idempotency-Key` header between 8 and 128 characters. Reusing the same key and body returns the original record; reusing it with a different body returns HTTP `409`.

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

- Memo is Testnet infrastructure. Only the Agent settlement flow is currently onchain; the launch, trade, and NFT screens remain simulations.
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

Before an approved quote is persisted, active reservations are summed under a serialized PostgreSQL transaction. A quote fails with `TREASURY_CAPACITY_EXCEEDED` when its payout would exceed the current Circle USDC balance after active reservations. Expiry, cancellation, or failure releases capacity; independently verified completion consumes it.

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
9. Start MemeVerse, verify `/api/v1/circle/wallet`, then use the explicit Memo settlement button on the Agent receipt.

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
npm run build
npm run preview
```

## Phase 3 verification evidence

- Deployment transaction: [`0x0125af5971f2f16d810174c5694b173dd779b8fdce6da3d73c9a77b490e43933`](https://testnet.arcscan.app/tx/0x0125af5971f2f16d810174c5694b173dd779b8fdce6da3d73c9a77b490e43933)
- End-to-end Memo settlement: [`0xbdd7b3edaf3a10bb8b81a8ef6eea1644fc04ccfd94ff938e3f528fdac4effac6`](https://testnet.arcscan.app/tx/0xbdd7b3edaf3a10bb8b81a8ef6eea1644fc04ccfd94ff938e3f528fdac4effac6)
- Indexed result: Circle `COMPLETE`, Arc event reconciliation `VERIFIED`, reservation `CONSUMED`

## Next implementation milestone — Phase 4

- Integrate Circle App Kits where they materially improve Send, Bridge, Swap, or Unified Balance UX
- Extend the agent with documented signal inputs and bounded autonomous decision rules
- Deploy managed PostgreSQL and a separately supervised worker for the public environment
- Add a professional smart-contract security review before any mainnet consideration

## License

MIT

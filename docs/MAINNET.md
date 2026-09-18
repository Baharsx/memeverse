# Arc mainnet cutover

Status: **code supports both networks. Production (https://memeverse.biz) is still Arc Testnet.**
Do not say "MemeVerse is live on Arc" until Gate 6 trade proof is verified on chain 5042.

Autonomy stays paused (`AGENT_AUTONOMOUS_ENABLED=false`) on first mainnet ship.

Facts below were re-verified 2026-09-18 against docs.arc.io and developers.circle.com.

## Official network facts

| | Mainnet | Testnet (staging) |
| --- | --- | --- |
| Chain ID | **5042** (`0x13b2`) | 5042002 (`0x4cef52`) |
| Never | **1243** (Archie Chain, not Arc) | |
| Read RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.io` |
| Read fallback | `https://rpc.drpc.mainnet.arc.io` | `https://rpc.drpc.testnet.arc.io` |
| Wallet EIP-3085 RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.network` |
| Explorer | `https://explorer.arc.io` | Product still uses `https://testnet.arcscan.app`; official docs name `https://explorer.testnet.arc.io` |
| Gas token | native USDC, 18 decimals | same model |
| ERC-20 USDC | `0x3600000000000000000000000000000000000000` (6 decimals, **same address**, real money on mainnet) | same address, test assets |
| Circle wallets chain code | `ARC` | `ARC-TESTNET` |
| Circle API key prefix | `LIVE_API_KEY:` | `TEST_API_KEY:` |
| Agent spend policies | mainnet only (`circle wallet limit set --chain ARC`) | application-level caps only |
| CCTP domain | 26 | 26 |

Read vs wallet RPC stay separate env fields on both networks. Do not point Markets reads at the wallet URL.

## Testnet product contracts — do not reuse on 5042

| Contract | Address |
| --- | --- |
| Factory | `0x363124490E953EEbB414eB4c3e2f03a40eef8F2C` |
| Settlement (manual) | `0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7` |
| Seed market | `0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D` |
| MediaNFT | `0x56A6f87e4d026E6D9d3E3c791A3A30e023bf1CFD` |
| NFTMarketplace | `0xfc3e869bA4Dd808A0942bc9C034f6f8427a08666` |
| Vault | `0xe26EeA49973226b406fd92Bd178484a29D7F7C05` |

Banned on every chain (legacy Phase 6A buy path):

- Factory `0x765E2Eaaba8eaEF4437B15CF42C1F268D3c8c08F`
- Market `0x5CcB34ec32e5ea12CdD7119157De9b8207b8880D`

## Phase 0 inventory (pre-cutover hardcodes)

These were the committed testnet-only values before dual-network support. Default env still selects them so memeverse.biz does not flip until Gate 4.

| Kind | Where |
| --- | --- |
| Chain id `5042002` | `server/config.js` (now from `ARC_NETWORK`), scripts, tests, `src/arc.js` default |
| Read RPC `rpc.testnet.arc.io` / `rpc.drpc.testnet.arc.io` | `src/arc.js`, `.env.example`, CSP, demo-preflight |
| Wallet RPC `rpc.testnet.arc.network` | `src/arc.js` (EIP-3085 only) |
| Explorer `testnet.arcscan.app` | `src/arc.js`, verify scripts, README |
| Circle `ARC-TESTNET` | settlement service, Circle gateways, kit client, deploy scripts (now `config.circleChainCode`) |
| Factory `0x3631…` | server default when network is testnet; frontend `arcContracts` / `VITE_MARKET_FACTORY_ADDRESS` |
| VITE media / marketplace / vault | `.env.example` testnet addresses |
| Imported-markets localStorage | was `memeverse.imported-markets.v1`; now `memeverse.imported-markets.v1.<chainId>` |

`publicMarkets()` still filters the presentation list. Factory enumeration still uses `factory.isMarket` via `markets(i)` / `isRegisteredFactoryMarket`.

## Dual-network env shape

```
ARC_NETWORK=testnet|mainnet
VITE_ARC_NETWORK=testnet|mainnet          # must agree with ARC_NETWORK
VITE_ARC_CHAIN_ID=5042002|5042
VITE_ARC_RPC_URL=                         # read transport
VITE_ARC_FALLBACK_RPC_URL=
VITE_ARC_WALLET_RPC_URL=                  # EIP-3085 only
VITE_ARC_EXPLORER_URL=
VITE_MARKET_FACTORY_ADDRESS=
VITE_MEDIA_NFT_ADDRESS=
VITE_NFT_MARKETPLACE_ADDRESS=
VITE_USDC_VAULT_ADDRESS=
VITE_USDC_ADDRESS=0x3600000000000000000000000000000000000000
ARC_RPC_URL=                              # API/worker read RPC
MARKET_FACTORY_ADDRESS=
CIRCLE_API_KEY=                           # TEST_API_KEY: or LIVE_API_KEY:
CIRCLE_ENTITY_SECRET=                     # 64 hex; never in git; never in VITE_*
CIRCLE_WALLET_ID=
CIRCLE_AGENT_WALLET_ID=
AGENT_AUTONOMOUS_ENABLED=false
```

Default when unset: **testnet**. Production after cutover: **mainnet**, set only in `/etc/memeverse/memeverse.env` at Gate 4.

Boot: API and worker call `eth_chainId` and refuse to start if it does not match the configured chain id. Production also refuses to start if the RPC is unreachable.

## Mainnet contract addresses

Filled at Phase 2. Empty until then. Never copy the testnet factory here.

| Contract | Address | Tx |
| --- | --- | --- |
| Factory | _pending deploy_ | |
| Seed market | | |
| MediaNFT | | |
| NFTMarketplace | | |
| Vault | | |
| Settlement (manual) | | |
| Settlement (agent) | | |

## Language

- No independent audit. Never write "audited".
- Do not say official partner / founding validator / Circle's chain.
- "MemeVerse is live on Arc." only after Gate 6.
- No APY claims.

## Rollback

Production is still testnet until Gate 4–5. After a mistaken mainnet env flip:

1. Restore the testnet env backup:
   `sudo cp /etc/memeverse/memeverse.env.bak-testnet /etc/memeverse/memeverse.env`
2. Confirm `VITE_ARC_NETWORK=testnet`, `ARC_NETWORK=testnet`, `AGENT_AUTONOMOUS_ENABLED=false`.
3. Rebuild and restart with the updater (do not `git pull` as root):
   `curl -fsSL https://raw.githubusercontent.com/Baharsx/memeverse/main/scripts/update-production.sh | sudo bash`

If `feat/arc-mainnet` is not on `main` yet, do not run that updater against main; stay on the current live SHA.

Code rollback of the dual-network branch is `VITE_ARC_NETWORK=testnet` + rebuild. Do not force-push `main`.

## Gate order

0 inventory → 1 code (this file + dual-network) → Gate 1 Circle LIVE keys → Gate 2 fund deployer → Phase 2 deploy on 5042 → Gate 3 agent wallet + policy → Phase 3 commit addresses → Gate 4 server env → Gate 5 updater → Gate 6 one buy and one sell → Phase 4 announcement.

Fresh DB and fresh Circle wallets on mainnet. No testnet state copy.

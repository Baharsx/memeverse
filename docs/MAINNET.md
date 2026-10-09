# Arc mainnet cutover

Status: **MemeVerse is live on Arc mainnet (chain 5042).** Production (https://memeverse.biz) serves that chain. A buy and a sell of the seed market are recorded below. No independent audit. Not an official partner. Autonomous rewards are not live.

This cutover deploys with an EOA. **Circle is not used on mainnet.** Do not call the Circle Contracts API, `circle:setup`, `circle:fund`, or `circle:deploy:*` against chain 5042. Do not create a Circle agent wallet. `AGENT_AUTONOMOUS_ENABLED` stays `false`. Autonomous rewards are not live. Creator and treasury fees still settle inside the trade.

Facts re-verified 2026-10-08 against docs.arc.io and `eth_chainId` on `https://rpc.mainnet.arc.io` (`0x13b2` = 5042). The same result came back from `https://rpc.drpc.mainnet.arc.io`.

## Official network facts

| | Mainnet | Testnet (staging) |
| --- | --- | --- |
| Chain ID | **5042** (`0x13b2`) | 5042002 (`0x4cef52`) |
| Never | **1243** (Archie Chain, not Arc) | |
| Read RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.io` |
| Read fallback | `https://rpc.drpc.mainnet.arc.io` | `https://rpc.drpc.testnet.arc.io` |
| Wallet EIP-3085 RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.network` |
| Explorer | `https://explorer.arc.io` | Product still uses `https://testnet.arcscan.app`; official docs name `https://explorer.testnet.arc.io` |
| Gas token | native USDC, 18 decimals (`eth_getBalance`) | same model |
| ERC-20 USDC | `0x3600000000000000000000000000000000000000` (6 decimals, **same address**, real money on mainnet) | same address, test assets |
| Circle | **not used** | `ARC-TESTNET` and `TEST_API_KEY` only |

Read RPC and wallet EIP-3085 RPC stay separate env fields even when the host is the same. Mainnet has no faucet.

## Testnet product contracts — do not reuse on 5042

| Contract | Address |
| --- | --- |
| Factory | `0x363124490E953EEbB414eB4c3e2f03a40eef8F2C` |
| Settlement (manual) | `0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7` |
| Seed market | `0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D` |
| MediaNFT | `0x56A6f87e4d026E6D9d3E3c791A3A30e023bf1CFD` |
| NFTMarketplace | `0xfc3e869bA4Dd808A0942bc9C034f6f8427a08666` |
| Vault | `0xe26EeA49973226b406fd92Bd178484a29D7F7C05` |
| Agent settlement | `0x2176107C2562Ed30ca1d490C43cD53C3369946e2` |

Banned on every chain (legacy Phase 6A buy path):

- Factory `0x765E2Eaaba8eaEF4437B15CF42C1F268D3c8c08F`
- Market `0x5CcB34ec32e5ea12CdD7119157De9b8207b8880D`

## What this cutover deploys

`npm run deploy:mainnet:eoa` deploys **MemeVerseFactory** and **one seed market** only. Constructor arguments match the testnet Phase 6A.1 exact-spend factory: USDC `0x3600…0000`, treasury = deployer, creator fee 100 bps, treasury fee 100 bps. The seed market is MEMEVERSE GENESIS / MMV, supply 100000, base price 100, slope 1000 (6-decimal USDC units).

MediaNFT, the NFT marketplace, and the vault are skipped. Leave those env values empty or unchanged. Do not point them at the testnet addresses while `VITE_ARC_NETWORK=mainnet`.

The script reads `DEPLOYER_PRIVATE_KEY` from the environment or from `/etc/memeverse/memeverse.env`. It never prints the key. It refuses to broadcast unless `eth_chainId` is 5042, the balance is at least 0.8 native USDC, and the estimated deploy cost leaves at least 0.15 native USDC.

## Phase 0 inventory

Default env still selects testnet, so memeverse.biz does not flip until the server env gate.

| Kind | Where |
| --- | --- |
| Chain id `5042002` | default of `resolveArcNetwork`, tests, `src/arc.js` when `VITE_ARC_NETWORK` is unset |
| Read RPC `rpc.testnet.arc.io` / `rpc.drpc.testnet.arc.io` | testnet catalog, `.env.example`, CSP |
| Wallet RPC `rpc.testnet.arc.network` | testnet catalog (EIP-3085 only) |
| Explorer `testnet.arcscan.app` | testnet catalog and the testnet verify script |
| Circle | not used. The Circle and agent settlement programs were removed from this repository |
| Factory `0x3631…` | testnet catalog default. On mainnet a stale `MARKET_FACTORY_ADDRESS` is ignored. A new `VITE_MEMEVERSE_FACTORY_ADDRESS` or `VITE_MARKET_FACTORY_ADDRESS` that is a testnet product contract is rejected |
| VITE media / marketplace / vault | testnet addresses in `.env.example`. A mainnet build nulls them when they are testnet product contracts |
| Imported-markets localStorage | `memeverse.imported-markets.v1.<chainId>` |
| `publicMarkets()` | still a synchronous presentation filter. `loadMarkets` drops addresses where `factory.isMarket` is false |

Server boot calls `eth_chainId` and refuses to start on a mismatch. A mainnet boot also refuses when the RPC cannot be reached. The browser does the same check before render when `VITE_ARC_NETWORK=mainnet`.

## Mainnet contract addresses

Filled after the EOA deploy. Empty until then. Never copy a testnet address into this table.

| Contract | Address | Transaction |
| --- | --- | --- |
| Factory | `0x177492EFFbe5F7847994696ef4C9B24b8C9C13BE` | [`0xf22d7f45…`](https://explorer.arc.io/tx/0xf22d7f45a8bd53a19fed27b2bdde68a092cd98cf862f9bccdb5a962445df66e2) |
| Seed market | `0xDCa07Bd83bc7A4220C79afB60F8C2Bb7DC746932` | [`0x17943aeb…`](https://explorer.arc.io/tx/0x17943aebd1437c85dde62b5375b1a24e54a5ca1f682313ba033e2c37b9a31fca) |
| MediaNFT | not in this cutover | |
| NFTMarketplace | not in this cutover | |
| Vault | not in this cutover | |
| Settlement | not in this cutover. Circle settlement stays testnet-only | |

Deployed 2026-10-08 from `0x5A119569569907B5D8bb94efA84375682240A85c`. `eth_chainId` was 5042 on `https://rpc.mainnet.arc.io` and on `https://rpc.drpc.mainnet.arc.io`. Factory constructor: USDC `0x3600000000000000000000000000000000000000`, treasury = deployer, creator fee 100 bps, treasury fee 100 bps. Seed market MEMEVERSE GENESIS / MMV is the only `markets(0)` entry, and `isMarket` is true. Explorer source is verified for `MemeVerseFactory` and `MemeMarket` (`MemeVerseMarket.sol`, solc `v0.8.30+commit.73712a01`, optimizer 200 runs, EVM cancun): [factory](https://explorer.arc.io/address/0x177492EFFbe5F7847994696ef4C9B24b8C9C13BE) and [seed](https://explorer.arc.io/address/0xDCa07Bd83bc7A4220C79afB60F8C2Bb7DC746932). Native balance after both receipts: 1.006293 USDC.

Proof trade. Both receipts are on chain 5042 (`eth_chainId` 5042, status success). Wallet `0x76B74337D93dBcB811FcF2DAb4a57Db2b7058389` bought 97 MMV of MEMEVERSE GENESIS for 0.009940 USDC, then sold that 97 MMV back for 0.009552 USDC. `soldTokenCount` returned to 0. Creator and treasury fees of 0.000097 USDC each settled inside each trade, to the deployer treasury.

| Side | Transaction |
| --- | --- |
| Buy | [`0xc0244186…`](https://explorer.arc.io/tx/0xc0244186032724f00b77fc21a16c6f9c78c44782a3673536358d2b98ed208e5a) block 25028579 |
| Sell | [`0x88135e0d…`](https://explorer.arc.io/tx/0x88135e0d7709cd677309be7936db12653315cf60849a46c73948787f60e82616) block 25028626 |

## Language

- No independent audit. Do not write "audited".
- Do not say official partner, founding validator, or Circle's chain.
- Do not say autonomous rewards are live on mainnet.
- The proof-trade receipts above are the basis for "MemeVerse is live on Arc."
- Built on Arc. USDC markets.

## Rollback

1. Restore the testnet env backup:
   `sudo cp /etc/memeverse/memeverse.env.bak-testnet /etc/memeverse/memeverse.env`
2. Confirm `VITE_ARC_NETWORK=testnet` and `AGENT_AUTONOMOUS_ENABLED=false`.
3. Rebuild with the updater. Do not `git pull` as root:
   `curl -fsSL https://raw.githubusercontent.com/Baharsx/memeverse/main/scripts/update-production.sh | sudo bash`

If `feat/arc-mainnet` is not on `main` yet, check out that branch before the updater's `git checkout` of `origin/main`. Do not force-push `main`.

## Human gates

Work stops at each gate until the operator replies `DONE GATE N` (or "انجام شد") with the requested values.

1. Fund the deployer with about 1 USDC on chain 5042 if `eth_getBalance` is under 0.8 USDC.
2. Backup `/etc/memeverse/memeverse.env`, paste the `VITE_*` block, keep database secrets, set `AGENT_AUTONOMOUS_ENABLED=false`, mode `0600`, owner `memeverse`.
3. Run the production updater as root. If this branch is not on `main`, check the branch out first.
4. From the deployer wallet, buy a tiny amount of the seed market and sell it back. Paste both explorer URLs.

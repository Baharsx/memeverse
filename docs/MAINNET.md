# MemeVerse — Arc mainnet deployment

MemeVerse **Launch and Markets** are live on Arc mainnet **chain 5042**.
The live website is [memeverse.biz](https://memeverse.biz).
Trades use real USDC, and creator/treasury fees settle inside the trade.
**Contracts have not been independently audited.**

## Network identity

| Property | Arc mainnet | Arc testnet |
| --- | --- | --- |
| Chain ID | 5042 (`0x13b2`) | 5042002 (`0x4cef52`) |
| Read RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.io` |
| Fallback RPC | `https://rpc.drpc.mainnet.arc.io` | `https://rpc.drpc.testnet.arc.io` |
| Explorer | `https://explorer.arc.io` | `https://testnet.arcscan.app` |
| ERC-20 USDC | `0x3600000000000000000000000000000000000000` (6 decimals) | Same address, test assets |

Read and wallet-registration RPC endpoints are separate deployment settings.
Never use a testnet product contract address on chain 5042.

## Deployed contracts — October 8, 2026

| Contract | Address | Proof |
| --- | --- | --- |
| MemeVerseFactory | `0x177492EFFbe5F7847994696ef4C9B24b8C9C13BE` | [Deployment transaction](https://explorer.arc.io/tx/0xf22d7f45a8bd53a19fed27b2bdde68a092cd98cf862f9bccdb5a962445df66e2) |
| MEMEVERSE GENESIS market | `0xDCa07Bd83bc7A4220C79afB60F8C2Bb7DC746932` | [Deployment transaction](https://explorer.arc.io/tx/0x17943aebd1437c85dde62b5375b1a24e54a5ca1f682313ba033e2c37b9a31fca) |

Factory source: [verified explorer address](https://explorer.arc.io/address/0x177492EFFbe5F7847994696ef4C9B24b8C9C13BE).
Genesis market source: [verified explorer address](https://explorer.arc.io/address/0xDCa07Bd83bc7A4220C79afB60F8C2Bb7DC746932).

Deployed on October 8, 2026 from `0x5A119569569907B5D8bb94efA84375682240A85c`.
Factory constructor: USDC as listed above, treasury = deployer, creator fee 100 bps,
treasury fee 100 bps. Seed market supply 100,000; base price 100 and slope 1,000
(six-decimal USDC units).

Verified test trade:
The original buy/sell transaction details remain available in the Git history of this document.

## Production configuration and deploy

Nginx serves the Vite `dist/` build; systemd starts the Node API.
The API stores market artwork under `MEDIA_STORAGE_DIR` and signed referral
attributions under its `referrals/` subdirectory. Back up both.
The service user must be able to write to that directory.

The repository merge **does not automatically update the VPS**. From the
production host (with existing service/environment verified), run:

```bash
sudo bash /opt/memeverse/scripts/update-production.sh
```

After deployment, verify the public homepage, `/launch`, `/markets`,
`/referral` and `/campaigns`, plus `/api/health`.
Do not execute market-deploying scripts just to publish a frontend change.

## Scope and rewards

Only market launching and trading move funds. Referrals record a wallet-signed
relationship for future review; planned campaigns do not pay money or award
points. See [Rewards status](./REWARDS.md).

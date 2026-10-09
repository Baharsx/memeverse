# MemeVerse

A meme becomes a market. People trade it in USDC. The creator and the treasury earn inside that same trade, and every receipt is an Arc transaction you can open yourself.

**MemeVerse is live on Arc.** The markets run on Arc mainnet, chain `5042`. The money is real USDC, and USDC is the gas too.

Come in: **<https://memeverse.biz>**

The first market is MEMEVERSE GENESIS (`MMV`). Someone bought it, then sold it back. Both receipts, the factory, and the seed market are written down in [`docs/MAINNET.md`](./docs/MAINNET.md).

```
LAUNCH → MARKETS → NFT → VAULT
```

Launch and markets are the live product. NFT and the vault are in the app. They are not deployed on this mainnet yet, so the wider product is not mainnet-ready. There is no independent audit. MemeVerse does not use Circle, and it does not pay creators from an agent wallet. Creator and treasury fees settle inside the trade.

## Start here

| If you want to… | Go to |
| --- | --- |
| Trade a market | <https://memeverse.biz/markets> |
| Launch a meme | <https://memeverse.biz/launch> |
| Open NFTs | <https://memeverse.biz/nft> |
| Open the vault | <https://memeverse.biz/vault> |
| See the mainnet addresses and the proof trade | [`docs/MAINNET.md`](./docs/MAINNET.md) |

## How it fits together

```
Browser                   reads the Arc contracts itself
      │
API                       health, sign-in, and artwork
      │
Arc mainnet               the live USDC markets
```

Arc is the ground because USDC is both the money and the gas. A price, a fee, and the cost of the click are the same unit.

## Look for yourself

```bash
npm ci
npm run demo:preflight
NODE_ENV=test npm test
NODE_ENV=production npm run build
```

Those commands only read. They do not send a transaction.

## Update the live site

On the host, as root. Do not `git pull` as root. The checkout belongs to `memeverse`.

```bash
curl -fsSL https://raw.githubusercontent.com/Baharsx/memeverse/main/scripts/update-production.sh | sudo bash
```

Later updates are `sudo bash /opt/memeverse/scripts/update-production.sh`. The script fetches `origin/main` as `memeverse`, rebuilds the site from the `VITE_*` lines in `/etc/memeverse/memeverse.env`, and restarts the API.

---

Markets, balances, and receipts come from the chain. Nothing on the markets page is invented. Mainnet USDC is real money.

## Built on Arc

MemeVerse is its own product. The name and the pictures are ours. Arc is the ground under them: USDC markets, USDC gas, and a receipt for every trade.

**Meme markets** — wallet-signed token and bonding-market deployment through `MemeVerseFactory`. The page lists live supply, price, reserve, and position. Buys and sells use real USDC, with minimum-output slippage protection. A 1% creator fee and a 1% treasury fee settle inside the same trade.

## Networks

### Arc mainnet

| Property | Value |
|---|---|
| Chain ID | `5042` (`0x13b2`) |
| Native gas | USDC, 18 decimals |
| ERC-20 USDC | `0x3600000000000000000000000000000000000000`, 6 decimals |
| Read RPC | `https://rpc.mainnet.arc.io` |
| Read fallback | `https://rpc.drpc.mainnet.arc.io` |
| Wallet RPC | `https://rpc.mainnet.arc.io` |
| Explorer | `https://explorer.arc.io` |
| Factory | [`0x177492EFFbe5F7847994696ef4C9B24b8C9C13BE`](https://explorer.arc.io/address/0x177492EFFbe5F7847994696ef4C9B24b8C9C13BE) |
| Seed market | [`0xDCa07Bd83bc7A4220C79afB60F8C2Bb7DC746932`](https://explorer.arc.io/address/0xDCa07Bd83bc7A4220C79afB60F8C2Bb7DC746932) MEMEVERSE GENESIS / MMV |

Only public browser configuration may use a `VITE_*` variable. Never place a private key in a Vite environment variable.

## Wallet connection (Reown AppKit)

**Reown AppKit is not Circle App Kit.** Reown AppKit is the WalletConnect-ecosystem wallet modal that visitors connect their own wallet through. MemeVerse does not use Circle. Everything belonging to the wallet modal is prefixed `reown` in the source.

The browser reaches a wallet two ways. A desktop browser extension announces itself over EIP-6963 and is connected directly. Every other case — Safari and Chrome on a phone, where no injected provider exists and never will — pairs over WalletConnect and opens the wallet app. Before this existed the app offered only the injected path, so an ordinary mobile browser was told `WALLET UNAVAILABLE`.

### Required configuration

| Variable | Value |
|---|---|
| `VITE_REOWN_PROJECT_ID` | The project id from <https://dashboard.reown.com> |

The project id is public configuration rather than a secret — it ships in the browser bundle — but it is per deployment, so no value is committed. **Without it there is no relay: desktop extension wallets still connect, and mobile cannot connect at all.** The header says so plainly rather than pretending otherwise.

### Required Reown dashboard settings

| Setting | Value | Why |
|---|---|---|
| Allowed origin | `https://memeverse.biz` | Must match `metadata.url`, or wallets show a mismatched-origin warning |
| Email login | Disabled | MemeVerse authenticates with a wallet signature, not an email |
| Social login | Disabled | Same |
| Swaps | Disabled | Not a MemeVerse product |
| On-ramp | Disabled | Not a MemeVerse product |

Those four **must** be turned off in the dashboard, not only in code. Since AppKit 1.7 they are remote features: when the project configuration is fetched successfully, the dashboard's values override whatever `features` the code passes, and AppKit logs a warning saying so. The code sets them to `false` as the intended configuration and as the fallback when that fetch fails.

### Arc-only product, WalletConnect session continuity

MemeVerse trades on Arc. Mainnet is chain `5042`. Testnet is chain `5042002`. The wallet list also carries Ethereum chain `1`, only so a phone wallet can open its first WalletConnect session. Without that extra entry, AppKit throws `ChainNotConfiguredError` before the wallet ever hears the request. Ethereum is not a place MemeVerse trades. The network picker is off, Arc is the default, and signing stays closed until the wallet is actually on the Arc chain this deployment asked for.

### What is deliberately not enabled

Coinbase Wallet connects as a browser extension over EIP-6963 and from the WalletConnect catalogue on mobile. Its third path, the Coinbase / Base Account popup SDK, bootstraps by injecting an inline `<script>`, which this site's `script-src 'self'` refuses — so AppKit does not register that connector and the modal shows no dead entry for it. Relaxing the policy to `unsafe-inline` would permit every injected script, not just that one, and is not a trade this project makes.

### Known platform limitation

Discord, Telegram, and most other Android in-app browsers block navigation to a wallet's URL scheme at the WebView or OS level. No application JavaScript can open a wallet app from inside one. When the app recognises such a browser *and* a connection has been attempted, it says `OPEN MEMEVERSE IN SAFARI / CHROME OR YOUR WALLET BROWSER` and nothing more. Ordinary Safari and Chrome visitors never see it. iOS in-app browsers largely cannot be detected at all — a `WKWebView` reports a user agent nearly identical to Safari's — so they are not guessed at.

## Architecture

```text
Connected wallet → MemeVerseFactory → MemeMarket / ERC-20 asset
                                          ↕
                                    Arc USDC (6 decimals)
                                          ↓
                               Creator + treasury fees
```

The factory has immutable USDC, treasury, and fee configuration and no admin mutation surface. A market holds its unsold fixed supply, tracks whole-token circulating supply, retains the exact curve reserve, and transfers fees immediately. The chain is authoritative.

## Production build

```bash
NODE_ENV=production npm run build
```

`VITE_BASE_PATH` sets the build's base path. The committed default is `/memeverse/`; a root-domain deployment sets `VITE_BASE_PATH=/`. The client router derives its basename from the same value, so the two cannot disagree.

**SPA history fallback is required.** `/`, `/markets`, `/launch`, `/nft`, and `/vault` must render on direct navigation and on refresh, so the edge has to serve `index.html` for unmatched paths under the base:

```nginx
location /memeverse/ {
  alias /opt/memeverse/dist/;
  try_files $uri $uri/ /memeverse/index.html;

  # The static document is served by nginx, not by the API, so it does not inherit the API's
  # security headers. These three have to be sent here or the frontend has none.
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "no-referrer" always;
  # Deliberately frame-ancestors only. The full policy travels in the built document's
  # <meta http-equiv="Content-Security-Policy">, and frame-ancestors is the one directive a
  # browser is defined to ignore there — so it is the one directive that must come over HTTP.
  # Restating the whole CSP here would create a second copy to keep in sync, and the copy that
  # drifts is always the one in production.
  add_header Content-Security-Policy "frame-ancestors 'none';" always;
}
location /api/ {
  proxy_pass http://127.0.0.1:8787;
}
```

## Known limitations

- NFT and the vault are not on this mainnet deployment. The wider product is not mainnet-ready.
- There is no independent audit.
- The curve trades whole tokens. It is simple on purpose.

## License

MIT

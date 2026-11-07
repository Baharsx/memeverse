# MemeVerse

A meme becomes a market. Launch, discover, and trade meme markets in USDC on Arc. Creator and treasury fees settle inside each trade.

Live at **<https://memeverse.biz>**.

Token artwork is selected during launch and attached once after the market confirms. The first successful image is permanent in the application: later replacements are rejected, while retrying the same image remains safe.

```
LAUNCH → MARKETS → REFERRAL → CAMPAIGNS
```

Launch and Markets are live on Arc mainnet, chain `5042`, using real USDC. Contract code has not been independently audited. Referral attribution is available via wallet signature; campaign and monetary rewards are **not live**. No reward payouts, allocations, or rankings are implied.

Proof and addresses: [`docs/MAINNET.md`](./docs/MAINNET.md).

Update the live site, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/Baharsx/memeverse/main/scripts/update-production.sh | sudo bash
```

## Wallet connection (Reown AppKit)

Reown AppKit provides wallet connection. Visitors connect and sign with their own wallet.

| Setting | Value | Why |
|---|---|---|
| Allowed origin | `https://memeverse.biz` | Must match the site |
| Email login | Disabled | A wallet signature, not an email |
| Social login | Disabled | Same |
| Swaps | Disabled | Not a MemeVerse product |
| On-ramp | Disabled | Not a MemeVerse product |

Turn those four off in the Reown dashboard. The dashboard overrides the code.

## Rewards: referral and weekly trading pool

Rewards are paid in USDC from MemeVerse's own trading revenue (the 1% treasury fee on every trade):

- **Weekly trading pool**: 30% of the treasury fee, shared by everyone who traded that week by volume.
- **Referral**: 20% of the treasury fee on every trade an invited wallet makes after it signs the invite. Invite links carry a random code, never a wallet address; clicks alone are not referrals.
- **Platform**: keeps the other 50%. No wallet can ever get back more than half of the fee it paid, so wash trading and self-referral always lose money.

Weeks end every Monday 00:00 UTC; `npm run rewards:plan` and `npm run rewards:pay` settle them from the treasury. See [rewards rules, safety and operations](docs/REWARDS.md).

Signed referral records (wallet, referrer, chain and creation time) live inside `MEDIA_STORAGE_DIR/referrals/`. They contain no signatures or private keys. Back up that directory with the media storage. The API service user must have write permission to `MEDIA_STORAGE_DIR`.

## Local checks

Run `npm ci`, then `npm test` for application and contract tests, and `npm run build` for the deployment bundle.

For browser regression checks, install Chromium once with `npx playwright install chromium`, then run `npm run test:ui`. This builds a separate test bundle in `cache/ui-dist` and checks mobile layouts, navigation, creator/holding filters, private invite links, trade-dialog keyboard focus, quote debouncing, readable units, and motion. All RPC and API responses in this suite are browser fixtures; no network transactions are sent. The regular deployment build and `.env.local` are preserved.

Run `npm run dev` to preview the app locally. The existing `.env.local` selects the network; pulling the repository does not switch it from testnet to mainnet.

## Production

The site is a single-page app. `/`, `/markets`, `/launch`, `/referral`, and `/campaigns` must all open on refresh. nginx serves the files and these headers:

```nginx
location /memeverse/ {
  alias /opt/memeverse/dist/;
  try_files $uri $uri/ /memeverse/index.html;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header Content-Security-Policy "frame-ancestors 'none';" always;
}
location /api/ {
  proxy_pass http://127.0.0.1:8787;
}
```

`frame-ancestors` has to travel over HTTP. A meta tag cannot set it.

## License

[MIT](./LICENSE). Copyright (c) 2026 Soheil SL. The file is the full MIT license, warranty disclaimer included.

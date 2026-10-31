# MemeVerse

A meme becomes a market. Launch, discover, and trade meme markets in USDC on Arc. Creator and treasury fees settle inside each trade.

Live at **<https://memeverse.biz>**.

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

## Referral attribution and community programs

- **Referral**: Connect a wallet and share its unique referral URL. A new wallet must open that URL and explicitly sign a time-limited message. The API validates the wallet signature and Arc chain, and stores a one-time, immutable attribution on disk. Clicks alone are not referrals.
- **Campaigns**: An informational preview of potential trading, content, and community programs. No live tasks, points, leaderboards, rewards, or automatic payout claims.
- **No guarantees**: Trading, posting, connecting or registering a referral does not guarantee any payout. Rules, eligibility, budget and dates are not set.

Signed referral records (wallet, referrer, chain and creation time) live inside `MEDIA_STORAGE_DIR/referrals/`. They contain no signatures or private keys. Back up that directory with the media storage. The API service user must have write permission to `MEDIA_STORAGE_DIR`. See [rewards status and implementation](docs/REWARDS.md).

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

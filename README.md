# MemeVerse

A meme becomes a market. People trade it in USDC on Arc. Creator and treasury fees settle inside the trade.

Live at **<https://memeverse.biz>**.

```
LAUNCH → MARKETS → NFT → VAULT
```

Launch and markets are on Arc mainnet, chain `5042`. NFT and the vault are in the app. They are not deployed on this mainnet yet, so the wider product is not mainnet-ready. There is no independent audit. MemeVerse does not use Circle.

Proof and addresses: [`docs/MAINNET.md`](./docs/MAINNET.md).

Update the live site, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/Baharsx/memeverse/main/scripts/update-production.sh | sudo bash
```

## Wallet connection (Reown AppKit)

**Reown AppKit is not Circle App Kit.** It is the wallet modal. Visitors connect their own wallet.

| Setting | Value | Why |
|---|---|---|
| Allowed origin | `https://memeverse.biz` | Must match the site |
| Email login | Disabled | A wallet signature, not an email |
| Social login | Disabled | Same |
| Swaps | Disabled | Not a MemeVerse product |
| On-ramp | Disabled | Not a MemeVerse product |

Turn those four off in the Reown dashboard. The dashboard overrides the code.

## Production

The site is a single-page app. `/`, `/markets`, `/launch`, `/nft`, and `/vault` must still open on refresh. nginx serves the files and these headers:

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

MIT

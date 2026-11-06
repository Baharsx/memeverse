# Rewards program status

**Current status: preparation. No financial rewards are available or claimable.**

MemeVerse's live onchain product is Launch and Markets on Arc mainnet (5042).
Creator/treasury market fees are settled by the deployed market contracts; they
are separate from any future community reward initiative.

## Referral attribution (operational, no payouts)

A connected wallet automatically receives a stable random 12-character code, e.g. `/referral?ref=aB3_kD9-zX2q`. Codes use 72 bits of cryptographic randomness, contain no wallet address, and are not an encoded address. The server stores the private mapping in `MEDIA_STORAGE_DIR/referrals/invites/` with private filesystem permissions. Concurrent creation requests return the same persisted code.
An invitee visiting that link must connect their **own** wallet and confirm
the referrer with a free EIP-191 message signature. The message binds the domain,
network chain id, invite code, invitee wallet, and a five-minute timestamp. The inviter's wallet is neither in that message nor the registration response. There is no public code-to-wallet lookup. Invite generation is origin-checked and rate-limited; it creates a presentation alias and grants no spending or registration authority. Wallets remain public onchain; the code hides the address from the shared invite URL rather than providing anonymity against known-wallet comparisons.

Previously shared address-based links are converted to short-code URLs in the browser. Legacy signed registration messages remain accepted for cached clients; their responses also omit wallet addresses. Existing attribution records stay unchanged.

The backend checks origin, rate limits, signature age, signer identity, and
referrer != invitee. One address may register once; it cannot switch referrers.
The resulting wallet-to-wallet record is stored in `MEDIA_STORAGE_DIR/referrals/`.
Wallet address, referrer, invite code when present, chain id and timestamp are stored. No signature
or private key is retained. Backup this directory with media storage. The
registration endpoint does not disclose referral lists or aggregated metrics.

A valid referral registration is **not proof** of verified trading, eligible
activity, or reward qualification. Anti-abuse checks and award rules have not
been defined. Do not promise financial returns or invite wash trading.

## Campaigns (planning only)

The `/campaigns` page explains planned categories:
- Trading activity, subject to independently defined anti-abuse criteria.
- Original educational, social, or creator content.
- Useful community participation.

No campaigns accept entries yet. There is no points accounting, leaderboard,
wallet distribution, reward engine, payout service, or automatic award mechanism.
Dates, eligibility rules, review policy, rewards budget, jurisdictions, claim
mechanism, and dispute process need publication **before** a campaign launches.

Use existing wallet-signed activity and verifiable onchain transactions to
design any future eligibility engine. Don't add unverifiable reward counters
to the UI or automatically transfer funds to users.

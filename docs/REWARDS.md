# Rewards program status

**Current status: preparation. No financial rewards are available or claimable.**

MemeVerse's live onchain product is Launch and Markets on Arc mainnet (5042).
Creator/treasury market fees are settled by the deployed market contracts; they
are separate from any future community reward initiative.

## Referral attribution (operational, no payouts)

A connected wallet can create a shareable link: `/referral?ref=0x...`.
An invitee visiting that link must connect their **own** wallet and confirm
the referrer with a free EIP-191 message signature. The message binds the domain,
network chain id, both wallet addresses, and a five-minute timestamp.

The backend checks origin, rate limits, signature age, signer identity, and
referrer != invitee. One address may register once; it cannot switch referrers.
The resulting wallet-to-wallet record is stored in `MEDIA_STORAGE_DIR/referrals/`.
Only wallet address, referrer, chain id and timestamp are stored. No signature
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

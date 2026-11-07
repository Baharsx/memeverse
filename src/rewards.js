/**
 * MemeVerse rewards, funded only by the platform's own trading revenue.
 *
 * Every trade pays 1% to the token creator and 1% to the MemeVerse treasury. Of the treasury fee:
 *   - 30% goes to the weekly trading pool, shared by each trader's own fee contribution (volume),
 *   - 20% goes to the wallet that referred the trader, for trades after the referral was signed,
 *   - 50% stays with the platform.
 * A wallet can therefore never receive more than half of the treasury fee its own trades produced,
 * so trading against yourself, even from a self-referred second wallet, always loses money, and
 * total payouts can never exceed half of real revenue.
 *
 * Pure: shared by the API, the payout script and the tests so all three compute identical numbers.
 */
export const TRADING_SHARE_BPS = 3_000n;
export const REFERRAL_SHARE_BPS = 2_000n;
const BPS = 10_000n;

export const WEEK_SECONDS = 7 * 86_400;
/** Trades from this moment count. Weekly epochs end every Monday 00:00 UTC. */
export const PROGRAM_START = Date.UTC(2026, 10, 7) / 1000; // Sat 7 Nov 2026 00:00 UTC
export const FIRST_EPOCH_END = Date.UTC(2026, 10, 16) / 1000; // Mon 16 Nov 2026 00:00 UTC
/** Smallest transfer the payout script sends; smaller balances wait for the next payout. */
export const MIN_PAYOUT_USDC = 50_000n; // 0.05 USDC

export function epochOf(at) {
  if (typeof at !== 'number' || at < PROGRAM_START) return null;
  if (at < FIRST_EPOCH_END) return 1;
  return 2 + Math.floor((at - FIRST_EPOCH_END) / WEEK_SECONDS);
}

export function epochBounds(epoch) {
  const start = epoch === 1 ? PROGRAM_START : FIRST_EPOCH_END + (epoch - 2) * WEEK_SECONDS;
  return { epoch, start, end: FIRST_EPOCH_END + (epoch - 1) * WEEK_SECONDS };
}

const lower = (address) => String(address ?? '').toLowerCase();
const big = (value) => { try { return BigInt(value ?? 0); } catch { return 0n; } };

function walletEntry(wallets, address) {
  return (wallets[address] ??= { address, epochs: {}, invited: 0, invitedTraded: 0 });
}
function walletEpoch(entry, epoch) {
  return (entry.epochs[epoch] ??= { volume: 0n, fees: 0n, trading: 0n, referral: 0n });
}

/**
 * @param trades   indexed trades: { trader, usdc, treasuryFee, at } (amounts as strings, 6 decimals)
 * @param referrals [{ wallet, referrer, createdAt (ISO) }]
 * @param payouts  ledger entries: { wallet, amount, status } — only 'confirmed' or 'sent' count as paid
 * @param exclude  addresses that never earn (the treasury itself)
 */
export function computeRewards({ trades = [], referrals = [], payouts = [], nowSeconds, exclude = [] }) {
  const current = epochOf(nowSeconds) ?? 1;
  const excluded = new Set(exclude.map(lower));
  const referrerOf = new Map();
  for (const record of referrals) {
    const wallet = lower(record.wallet);
    const referrer = lower(record.referrer);
    if (!wallet || !referrer || wallet === referrer) continue;
    referrerOf.set(wallet, { referrer, since: Math.floor(Date.parse(record.createdAt) / 1000) || 0 });
  }

  const epochs = {};
  const wallets = {};
  for (const { referrer } of referrerOf.values()) {
    if (!excluded.has(referrer)) walletEntry(wallets, referrer).invited += 1;
  }
  const tradedInvitees = new Set();

  for (const trade of trades) {
    const epoch = epochOf(trade.at);
    if (epoch === null) continue;
    const fee = big(trade.treasuryFee);
    const volume = big(trade.usdc);
    const trader = lower(trade.trader);
    const totals = (epochs[epoch] ??= { ...epochBounds(epoch), final: epoch < current, fees: 0n, volume: 0n, trades: 0, tradingPool: 0n, referralPaid: 0n, traders: {} });
    totals.fees += fee;
    totals.volume += volume;
    totals.trades += 1;
    if (excluded.has(trader)) continue;
    const mine = walletEpoch(walletEntry(wallets, trader), epoch);
    mine.volume += volume;
    mine.fees += fee;
    const link = referrerOf.get(trader);
    if (link && trade.at >= link.since && !excluded.has(link.referrer)) {
      walletEpoch(walletEntry(wallets, link.referrer), epoch).referral += (fee * REFERRAL_SHARE_BPS) / BPS;
      if (!tradedInvitees.has(trader)) { tradedInvitees.add(trader); walletEntry(wallets, link.referrer).invitedTraded += 1; }
    }
  }

  // The trading pool is shared by fee contribution, which equals each trader's own share of 30%.
  for (const entry of Object.values(wallets)) {
    for (const [epoch, mine] of Object.entries(entry.epochs)) {
      mine.trading = (mine.fees * TRADING_SHARE_BPS) / BPS;
      const totals = epochs[epoch];
      if (!totals) continue;
      totals.tradingPool += mine.trading;
      totals.referralPaid += mine.referral;
      if (mine.volume > 0n) totals.traders[entry.address] = mine.volume;
    }
  }

  const paid = {};
  for (const entry of payouts) {
    if (entry.status !== 'confirmed' && entry.status !== 'sent') continue;
    paid[lower(entry.wallet)] = (paid[lower(entry.wallet)] ?? 0n) + big(entry.amount);
  }
  for (const entry of Object.values(wallets)) {
    let finalized = 0n;
    let pending = 0n;
    for (const [epoch, mine] of Object.entries(entry.epochs)) {
      const amount = mine.trading + mine.referral;
      if (Number(epoch) < current) finalized += amount; else if (Number(epoch) === current) pending += amount;
    }
    entry.earned = finalized;
    entry.thisWeek = pending;
    entry.paid = paid[entry.address] ?? 0n;
    entry.unpaid = finalized > entry.paid ? finalized - entry.paid : 0n;
  }
  return { current, epochs, wallets };
}

/** Wallets whose finalized, unpaid rewards reach the minimum transfer. */
export function payoutPlan(result, minimum = MIN_PAYOUT_USDC) {
  return Object.values(result.wallets)
    .filter((entry) => entry.unpaid >= minimum)
    .map((entry) => ({ wallet: entry.address, amount: entry.unpaid }))
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : a.wallet.localeCompare(b.wallet)));
}

/** A reward in dollars: small amounts keep four decimals so early rewards never read as $0. */
export function formatReward(units) {
  const value = big(units);
  if (value <= 0n) return '$0';
  const decimals = value < 10_000n ? 4 : 2;
  const scale = 10n ** BigInt(6 - decimals);
  const rounded = value / scale;
  const whole = rounded / 10n ** BigInt(decimals);
  const digits = (rounded % 10n ** BigInt(decimals)).toString().padStart(decimals, '0');
  const fraction = decimals === 2 ? (digits === '00' ? '' : digits) : digits.replace(/0+$/, '');
  return '$' + whole.toLocaleString('en-US') + (fraction ? '.' + fraction : '');
}

/** "2d 4h", "3h 12m" or "8m" until `end` (seconds). */
export function timeLeft(end, nowSeconds = Math.floor(Date.now() / 1000)) {
  const left = Math.max(0, end - nowSeconds);
  const days = Math.floor(left / 86_400);
  const hours = Math.floor((left % 86_400) / 3_600);
  const minutes = Math.floor((left % 3_600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

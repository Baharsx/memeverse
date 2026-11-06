/** Presentation rules for indexed trade activity. Pure so they can be tested without a browser. */

function bigint(value) {
  try { return BigInt(value ?? 0); } catch { return 0n; }
}

export const TREND_PERIODS = Object.freeze([['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'ALL']]);

/** One market's trades and USDC volume inside a period, tolerating older API payloads. */
export function periodStats(entry, period) {
  if (entry?.periods?.[period]) return entry.periods[period];
  if (period === 'all') return { trades: entry?.trades ?? 0, volumeUsdc: entry?.volumeUsdc ?? '0' };
  if (period === '24h') return { trades: entry?.trades24h ?? 0, volumeUsdc: entry?.volume24hUsdc ?? '0' };
  return { trades: 0, volumeUsdc: '0' };
}

/**
 * Markets that traded in `period`, by USDC volume and then trade count. A market without a trade
 * in the period is left out: a trend is never invented.
 */
export function trendingMarkets(markets, stats, limit = 5, period = '24h') {
  return (markets ?? [])
    .map((market) => ({ market, stats: stats?.[market.address], window: periodStats(stats?.[market.address], period) }))
    .filter(({ stats: entry, window }) => entry && window.trades > 0)
    .sort((a, b) => {
      const volume = bigint(b.window.volumeUsdc) - bigint(a.window.volumeUsdc);
      if (volume !== 0n) return volume > 0n ? 1 : -1;
      return b.window.trades - a.window.trades;
    })
    .slice(0, limit);
}

/** The shortest period that has any trade, so the panel opens on something real. */
export function defaultTrendPeriod(markets, stats) {
  return TREND_PERIODS.map(([period]) => period).find((period) => trendingMarkets(markets, stats, 1, period).length) ?? '24h';
}

export function timeAgo(seconds, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof seconds !== 'number') return '';
  const elapsed = Math.max(0, nowSeconds - seconds);
  if (elapsed < 60) return 'just now';
  if (elapsed < 3_600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86_400) return `${Math.floor(elapsed / 3_600)}h ago`;
  return `${Math.floor(elapsed / 86_400)}d ago`;
}

export function shortTrader(address) {
  return typeof address === 'string' && address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
}

/** A USDC amount (6 decimals) as dollars; a positive amount under a cent never reads as $0. */
export function formatDollars(units) {
  const value = bigint(units);
  if (value <= 0n) return '$0';
  if (value < 10_000n) return '<$0.01';
  const cents = value / 10_000n;
  const rest = (cents % 100n).toString().padStart(2, '0');
  return '$' + (cents / 100n).toLocaleString('en-US') + (rest === '00' ? '' : '.' + rest);
}

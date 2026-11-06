/** Presentation rules for indexed trade activity. Pure so they can be tested without a browser. */

function bigint(value) {
  try { return BigInt(value ?? 0); } catch { return 0n; }
}

/**
 * Markets ordered by 24h USDC volume, then 24h trades, then all-time volume. Markets without any
 * recorded trade are left out: "trending" must never be invented.
 */
export function trendingMarkets(markets, stats, limit = 3) {
  return (markets ?? [])
    .map((market) => ({ market, stats: stats?.[market.address] }))
    .filter(({ stats: entry }) => entry && entry.trades > 0)
    .sort((a, b) => {
      const volume = bigint(b.stats.volume24hUsdc) - bigint(a.stats.volume24hUsdc);
      if (volume !== 0n) return volume > 0n ? 1 : -1;
      if (b.stats.trades24h !== a.stats.trades24h) return b.stats.trades24h - a.stats.trades24h;
      const total = bigint(b.stats.volumeUsdc) - bigint(a.stats.volumeUsdc);
      return total === 0n ? 0 : (total > 0n ? 1 : -1);
    })
    .slice(0, limit);
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

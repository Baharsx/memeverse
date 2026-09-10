/**
 * Presentation helpers for the creator-media marketplace board.
 * Dependency-free so Node tests and the browser bundle share one implementation.
 */

export function filterMediaAssets(assets, { tab = 'all', query = '', wallet = null } = {}) {
  if (!Array.isArray(assets)) return [];
  const needle = String(query ?? '').trim().toLowerCase();
  const owner = typeof wallet === 'string' ? wallet.trim().toLowerCase() : '';
  return assets.filter((asset) => {
    if (tab === 'listed' && !asset?.listing?.fillable) return false;
    if (tab === 'mine') {
      if (!owner) return false;
      if (String(asset?.owner ?? '').toLowerCase() !== owner) return false;
    }
    if (!needle) return true;
    const haystack = [
      asset?.metadata?.name,
      asset?.tokenId,
      asset?.market,
      asset?.creator,
      asset?.owner,
      asset?.listing?.fillable ? 'listed' : '',
    ].map((value) => String(value ?? '').toLowerCase());
    return haystack.some((value) => value.includes(needle));
  });
}

export function sortMediaAssets(assets, sort = 'newest') {
  const copy = Array.isArray(assets) ? [...assets] : [];
  copy.sort((left, right) => {
    if (sort === 'price') {
      const leftPrice = left?.listing?.fillable ? BigInt(left.listing.priceUnits ?? 0n) : null;
      const rightPrice = right?.listing?.fillable ? BigInt(right.listing.priceUnits ?? 0n) : null;
      if (leftPrice === null && rightPrice === null) {
        return Number(right?.tokenId ?? 0) - Number(left?.tokenId ?? 0);
      }
      if (leftPrice === null) return 1;
      if (rightPrice === null) return -1;
      if (leftPrice === rightPrice) return 0;
      return leftPrice < rightPrice ? -1 : 1;
    }
    return Number(right?.tokenId ?? 0) - Number(left?.tokenId ?? 0);
  });
  return copy;
}

/**
 * Presentation rules for the Creator Media gallery. Dependency-free, so the browser bundle and
 * the Node test suite can both use it.
 *
 * The counterpart of the market-level rule in `market-display.js`, and it exists for the same
 * reason and with the same boundaries.
 */

/**
 * Media tokens hidden from the public gallery.
 *
 * Token #1, "MemeVerse Genesis Mark", was minted while the media NFT contract and its provenance
 * check were being proven. It is a real token: still owned, still enumerable, still carrying its
 * onchain content commitment and its market provenance, and still readable by every audit and by
 * the contract itself. None of that changes here.
 *
 * Hiding it is a gallery decision only, applied where assets are rendered and nowhere near
 * `readMediaAssets()`, which continues to enumerate the whole collection from chain. A future
 * reader should be able to see immediately that this removes a card from a grid and does not
 * remove anything from Arc.
 *
 * Identity is the token id — permanent, assigned by the contract, and impossible to collide with.
 * Matching on a name, a creator, an owner, or an image URL would all be mutable or transferable,
 * and any of them could silently hide somebody else's mint later.
 */
export const LEGACY_HIDDEN_MEDIA_TOKEN_IDS = Object.freeze([1]);

// Compared as strings because a token id arrives as a BigInt from viem, as a number in a test,
// and as text from a URL. Normalizing once here means every caller gets the same answer whichever
// shape it happens to hold.
const HIDDEN = new Set(LEGACY_HIDDEN_MEDIA_TOKEN_IDS.map((id) => String(id)));

export function isLegacyHiddenMediaToken(tokenId) {
  if (tokenId === undefined || tokenId === null) return false;
  return HIDDEN.has(String(tokenId));
}

/**
 * The media assets a visitor should browse.
 *
 * Takes the full collection as read from chain and returns the renderable subset. The input is
 * never mutated, so the complete enumeration stays intact for anything that needs onchain truth.
 */
export function publicMediaAssets(assets) {
  if (!Array.isArray(assets)) return [];
  return assets.filter((asset) => !isLegacyHiddenMediaToken(asset?.tokenId));
}

import { getAddress, isAddress } from 'viem';

/**
 * The one canonical representation of a creator media authorization.
 *
 * The browser signs this exact string and the server rebuilds it from values it has independently
 * verified — the market address it checksummed, the hash it computed from the bytes it actually
 * received, the chain it is configured for. If the two ever produced different text the signature
 * would simply fail to recover, which is why both sides import this module rather than each
 * assembling their own variant. Nothing here touches the DOM or the filesystem, so it runs
 * unchanged in the bundle, in Node, and in tests.
 *
 * What the signature buys: proof that the wallet which the market contract names as `creator()`
 * asked for *these* bytes to be attached to *this* market, for *this* purpose, before a deadline.
 * It authorizes presentation media only. It moves no funds and approves no transaction.
 */

export const MEDIA_AUTHORIZATION_VERSION = 1;
export const MEDIA_AUTHORIZATION_DOMAIN = 'memeverse.biz';

/**
 * Actions are deliberately separate strings inside the signed payload, so a signature collected
 * for one purpose cannot be replayed as the other. Attaching a market's public artwork and
 * committing the bytes behind an NFT are different acts with different consequences.
 */
export const MEDIA_ACTIONS = Object.freeze({
  MARKET_AVATAR: 'MARKET_AVATAR',
  NFT_MEDIA: 'NFT_MEDIA',
});

/** Short-lived on purpose: a leaked authorization should stop being useful in minutes. */
export const MEDIA_AUTHORIZATION_MAX_TTL_MS = 5 * 60 * 1000;

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

/** A keccak256 digest, lowercased. Anything else is not a hash this protocol will carry. */
export function normalizeContentHash(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return HASH_PATTERN.test(trimmed) ? trimmed : null;
}

/** A checksummed market address, or null. Never throws for hostile input. */
export function normalizeMarketAddress(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!isAddress(trimmed)) return null;
  try {
    const address = getAddress(trimmed);
    return address === '0x0000000000000000000000000000000000000000' ? null : address;
  } catch {
    return null;
  }
}

/**
 * Builds the exact text the wallet signs.
 *
 * Every security-relevant field is inside the message: without the chain ID a signature from
 * another network would count, without the action the two upload routes would share authority,
 * and without the content hash the same signature would authorize any bytes at all.
 */
/**
 * Resolves an action name, consulting own properties only.
 *
 * A plain `MEDIA_ACTIONS[action]` walks the prototype chain, so `'toString'` or `'constructor'`
 * would resolve to an inherited function and read as a valid action. Freezing the object does not
 * prevent that — only refusing inherited keys does.
 */
export function normalizeMediaAction(action) {
  if (typeof action !== 'string') return null;
  return Object.hasOwn(MEDIA_ACTIONS, action) ? MEDIA_ACTIONS[action] : null;
}

export function mediaAuthorizationMessage({ action, chainId, market, contentHash, expiresAt }) {
  const normalizedAction = normalizeMediaAction(action);
  const normalizedMarket = normalizeMarketAddress(market);
  const normalizedHash = normalizeContentHash(contentHash);
  if (!normalizedAction) throw new Error('Unknown media authorization action.');
  if (!normalizedMarket) throw new Error('Media authorization needs a valid market address.');
  if (!normalizedHash) throw new Error('Media authorization needs a keccak256 content hash.');
  if (!Number.isInteger(chainId)) throw new Error('Media authorization needs a chain id.');

  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) throw new Error('Media authorization needs a valid expiry.');

  return [
    'MemeVerse Media Authorization',
    `Version: ${MEDIA_AUTHORIZATION_VERSION}`,
    `Domain: ${MEDIA_AUTHORIZATION_DOMAIN}`,
    `Action: ${normalizedAction}`,
    `Chain ID: ${chainId}`,
    `Market: ${normalizedMarket}`,
    `Content Hash: ${normalizedHash}`,
    `Expires At: ${expiry.toISOString()}`,
    '',
    'Signing attaches presentation media as this market\'s creator.',
    'It moves no funds, approves no transaction, and costs no gas.',
  ].join('\n');
}

/**
 * Whether an expiry is currently acceptable.
 *
 * Both directions matter. An expired authorization is stale; one valid for an implausibly long
 * time is a signature somebody could sit on, so the window is bounded at both ends rather than
 * only checking that the deadline has not passed.
 */
export function mediaAuthorizationExpiryState(expiresAt, now = new Date()) {
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return 'INVALID';
  const remaining = expiry.getTime() - now.getTime();
  if (remaining <= 0) return 'EXPIRED';
  // A small tolerance above the nominal TTL absorbs clock skew without widening the real window.
  if (remaining > MEDIA_AUTHORIZATION_MAX_TTL_MS + 60_000) return 'TOO_DISTANT';
  return 'VALID';
}

/** The expiry a freshly created authorization should carry. */
export function mediaAuthorizationExpiry(now = new Date()) {
  return new Date(now.getTime() + MEDIA_AUTHORIZATION_MAX_TTL_MS).toISOString();
}

/**
 * The image types this system accepts, and the extension the server — never the uploader — picks
 * for each. SVG is absent deliberately: it is a scriptable document format, and serving one from
 * the application's own origin would hand every uploader a stored-XSS primitive.
 */
export const ALLOWED_IMAGE_TYPES = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
});

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Normalizes what a browser reports for a file, without trusting it as proof of content. */
export function normalizeImageMimeType(value) {
  if (typeof value !== 'string') return null;
  const mime = value.split(';')[0].trim().toLowerCase();
  if (mime === 'image/jpg') return 'image/jpeg';
  // Own properties only, for the same reason actions are looked up that way.
  return Object.hasOwn(ALLOWED_IMAGE_TYPES, mime) ? mime : null;
}

/** The server-chosen file extension for a verified type, or null. */
export function imageExtensionFor(mimeType) {
  if (typeof mimeType !== 'string') return null;
  return Object.hasOwn(ALLOWED_IMAGE_TYPES, mimeType) ? ALLOWED_IMAGE_TYPES[mimeType] : null;
}

import { getAddress, keccak256, recoverMessageAddress } from 'viem';
import {
  MAX_IMAGE_BYTES,
  MEDIA_ACTIONS,
  mediaAuthorizationExpiryState,
  mediaAuthorizationMessage,
  normalizeContentHash,
  normalizeImageMimeType,
  normalizeMarketAddress,
  normalizeMediaAction,
} from '../../src/media-authorization.js';
import { detectImageType } from '../infrastructure/media-store.js';
import { DomainError } from './errors.js';

/**
 * Decides whether a set of bytes may be attached to a market, and stores them if so.
 *
 * The whole security argument of this feature lives in `authorize()`. An upload is accepted only
 * when four independent things agree:
 *
 *   1. the bytes really are one of three raster image formats, by signature and not by claim;
 *   2. the keccak256 of the bytes the server actually received matches the hash in the signed
 *      message, so a signature cannot be transplanted onto different content;
 *   3. the signed message recovers to an address, using text this module rebuilds itself rather
 *      than any text the client supplied;
 *   4. that recovered address is the `creator()` the market contract reports, read live from Arc,
 *      for a market the trusted factory confirms it registered.
 *
 * No server key, operator session, Circle wallet, or API credential participates in that decision.
 * The only authority is the creator's own wallet, and the only thing it authorizes is presentation
 * media.
 */

const MAX_UPLOAD_HEADER_LENGTH = 512;

function readHeader(request, name) {
  const value = request.get(name);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_UPLOAD_HEADER_LENGTH) return null;
  return trimmed;
}

const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

export class MediaService {
  constructor({ store, collector, chainId, logger = console }) {
    this.store = store;
    this.collector = collector;
    this.chainId = chainId;
    this.logger = logger;
  }

  get available() {
    return Boolean(this.store?.configured && this.collector);
  }

  /** Public readiness, carrying a status word and never a path. */
  async readiness() {
    if (!this.store) return { configured: false, status: 'NOT_CONFIGURED' };
    return this.store.readiness();
  }

  /**
   * Validates one upload end to end and returns what was stored.
   *
   * Ordering is deliberate: everything checkable without touching the network runs first, so a
   * malformed or forged request is rejected before it can make this server issue an RPC call on
   * the sender's behalf.
   */
  async authorize({ bytes, declaredMimeType, action, market, contentHash, expiresAt, signature }) {
    if (!this.available) {
      throw new DomainError('MEDIA_NOT_AVAILABLE', 'Media uploads are not available.', {
        status: 503,
      });
    }

    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new DomainError('MEDIA_EMPTY', 'The upload contained no image data.', { status: 400 });
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new DomainError('MEDIA_TOO_LARGE', 'Images must be 5 MB or smaller.', { status: 413 });
    }

    const normalizedAction = normalizeMediaAction(action);
    if (!normalizedAction) {
      throw new DomainError('MEDIA_ACTION_INVALID', 'Unknown media authorization action.', {
        status: 400,
      });
    }

    // The browser's declared type and the file's own bytes must agree. Either one alone is
    // insufficient: the claim can lie, and honouring only the bytes would let a caller store a
    // PNG under a type this server never intended to serve.
    const claimed = normalizeImageMimeType(declaredMimeType);
    if (!claimed) {
      throw new DomainError(
        'MEDIA_TYPE_UNSUPPORTED',
        'Images must be PNG, JPEG, or WebP.',
        { status: 415 },
      );
    }
    const detected = detectImageType(bytes);
    if (!detected) {
      throw new DomainError(
        'MEDIA_CONTENT_INVALID',
        'The uploaded file is not a valid PNG, JPEG, or WebP image.',
        { status: 415 },
      );
    }
    if (detected !== claimed) {
      throw new DomainError(
        'MEDIA_TYPE_MISMATCH',
        'The uploaded file does not match its declared image type.',
        { status: 415 },
      );
    }

    const normalizedMarket = normalizeMarketAddress(market);
    if (!normalizedMarket) {
      throw new DomainError('MEDIA_MARKET_INVALID', 'A valid market address is required.', {
        status: 400,
      });
    }
    const declaredHash = normalizeContentHash(contentHash);
    if (!declaredHash) {
      throw new DomainError('MEDIA_HASH_INVALID', 'A keccak256 content hash is required.', {
        status: 400,
      });
    }

    // The hash in the signed message must describe the bytes this server is holding, not the ones
    // the client says it sent.
    const actualHash = keccak256(bytes).toLowerCase();
    if (actualHash !== declaredHash) {
      throw new DomainError(
        'MEDIA_HASH_MISMATCH',
        'The uploaded bytes do not match the authorized content hash.',
        { status: 400 },
      );
    }

    const expiryState = mediaAuthorizationExpiryState(expiresAt);
    if (expiryState !== 'VALID') {
      throw new DomainError(
        'MEDIA_AUTHORIZATION_EXPIRED',
        'This media authorization is no longer valid. Sign again to continue.',
        { status: 401, details: { reason: expiryState } },
      );
    }

    if (typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) {
      throw new DomainError('MEDIA_SIGNATURE_INVALID', 'A wallet signature is required.', {
        status: 401,
      });
    }

    // Rebuilt from verified values only. Nothing the client sent as text is signed over.
    const message = mediaAuthorizationMessage({
      action: normalizedAction,
      chainId: this.chainId,
      market: normalizedMarket,
      contentHash: actualHash,
      expiresAt,
    });

    let signer;
    try {
      signer = getAddress(await recoverMessageAddress({ message, signature }));
    } catch {
      throw new DomainError('MEDIA_SIGNATURE_INVALID', 'The wallet signature could not be verified.', {
        status: 401,
      });
    }

    // Reads `isMarket` on the trusted factory and `creator()` on the market itself. An address
    // that is not a registered MemeVerse market fails here with 422 before any write.
    const resolved = await this.collector.resolveMarket(normalizedMarket);
    if (signer !== resolved.creatorAddress) {
      throw new DomainError(
        'MEDIA_NOT_CREATOR',
        'Only the wallet that created this market can attach its media.',
        { status: 403 },
      );
    }

    const stored = await this.store.putContent({
      bytes,
      keccakHash: actualHash.slice(2),
      mimeType: detected,
    });

    if (normalizedAction === MEDIA_ACTIONS.MARKET_AVATAR) {
      await this.store.setMarketImage({
        market: normalizedMarket,
        contentId: stored.contentId,
        contentHash: actualHash,
        mimeType: detected,
        creator: resolved.creatorAddress,
      });
    }

    return {
      action: normalizedAction,
      market: normalizedMarket,
      creator: resolved.creatorAddress,
      contentId: stored.contentId,
      contentHash: actualHash,
      mimeType: detected,
      byteLength: bytes.length,
      url: `/api/v1/media/content/${stored.contentId}`,
      deduplicated: Boolean(stored.deduplicated),
    };
  }

  /**
   * Reads stored bytes by content id.
   *
   * Routes go through here rather than reaching into the store, so the only thing that ever
   * escapes to a response is bytes and a server-determined MIME — never a path, never a stat.
   */
  async content(contentId) {
    if (!this.store?.configured) return null;
    return this.store.getContent(contentId);
  }

  /**
   * Resolves images for a batch of markets in one call, so a market list renders without one
   * request per row. Unknown or image-less markets are simply absent from the result.
   */
  async marketImages(markets) {
    if (!this.store?.configured) return {};
    // Normalize first, then dedupe: a list that names the same market in mixed case must cost one
    // filesystem read, not one per spelling.
    const unique = [...new Set(markets.map((candidate) => normalizeMarketAddress(candidate)))];
    const entries = await Promise.all(unique.map(async (normalized) => {
      if (!normalized) return null;
      const document = await this.store.getMarketImage(normalized);
      if (!document) return null;
      return [normalized, {
        contentId: document.contentId,
        contentHash: document.contentHash,
        mimeType: document.mimeType,
        updatedAt: document.updatedAt,
        url: `/api/v1/media/content/${document.contentId}`,
      }];
    }));
    return Object.fromEntries(entries.filter(Boolean));
  }
}

/** Extracts the authorization fields an upload carries in its headers. */
export function readUploadAuthorization(request) {
  return {
    action: readHeader(request, 'x-memeverse-action'),
    market: readHeader(request, 'x-memeverse-market'),
    contentHash: readHeader(request, 'x-memeverse-content-hash'),
    expiresAt: readHeader(request, 'x-memeverse-expires-at'),
    signature: readHeader(request, 'x-memeverse-signature'),
  };
}

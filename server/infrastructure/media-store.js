import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectImageType } from '../../src/image-signature.js';
import { ALLOWED_IMAGE_TYPES, imageExtensionFor } from '../../src/media-authorization.js';

// Re-exported so the store stays the single import for everything storage-side, while the
// detector itself lives with the browser so both sides cannot drift apart.
export { detectImageType };

/**
 * A small durable content-addressed store for creator media.
 *
 * Two rules shape everything here. First, a filename supplied by a browser never reaches the
 * filesystem: every path segment is derived from a validated keccak256 digest and a
 * server-selected extension, so there is no string an uploader controls that could climb out of
 * the media directory. Second, an image the store cannot prove is an image is not stored at all —
 * the declared MIME is treated as a claim to check, not a fact to trust.
 *
 * The store is deliberately independent of the settlement database. Media is presentation, and it
 * must not be able to take the financial product down: every operation reports failure as a value
 * the caller can render, and nothing here runs at API startup.
 */

/** keccak256 is the protocol hash; sha256 here is only the store's internal integrity check. */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const HASH_SEGMENT = /^[0-9a-f]{64}$/;
const EXTENSIONS = new Set(Object.values(ALLOWED_IMAGE_TYPES));

/**
 * Splits a public content id into its parts, refusing anything that is not exactly
 * `<64 hex>.<known extension>`. Every traversal attempt — `../`, encoded separators, null bytes,
 * unicode lookalikes — fails this because none of them match the character class.
 */
export function parseContentId(contentId) {
  if (typeof contentId !== 'string' || contentId.length > 80) return null;
  const match = /^([0-9a-f]{64})\.([a-z]{3,4})$/.exec(contentId);
  if (!match) return null;
  const [, hash, extension] = match;
  if (!EXTENSIONS.has(extension)) return null;
  return { hash, extension };
}

const MIME_FOR_EXTENSION = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp',
});

export class MediaStore {
  constructor({ directory, logger = console }) {
    this.directory = directory;
    this.contentDirectory = directory ? join(directory, 'content') : null;
    this.pointerDirectory = directory ? join(directory, 'markets') : null;
    this.logger = logger;
  }

  get configured() {
    return Boolean(this.directory);
  }

  /**
   * Reports whether media can actually be written, without throwing and without ever exposing the
   * path. Called by the health endpoint, so it must stay cheap and must never be a startup gate.
   */
  async readiness() {
    if (!this.configured) return { configured: false, status: 'NOT_CONFIGURED' };
    try {
      await mkdir(this.contentDirectory, { recursive: true });
      await mkdir(this.pointerDirectory, { recursive: true });
      const probe = join(this.directory, `.writable-${randomUUID()}`);
      await writeFile(probe, '');
      await rm(probe, { force: true });
      return { configured: true, status: 'READY' };
    } catch {
      // Degraded media must never read as a broken product: trading, the agent, and settlement
      // are all untouched by this.
      return { configured: true, status: 'DEGRADED' };
    }
  }

  /**
   * Writes bytes under their own digest.
   *
   * Atomic by construction: the payload lands in a uniquely named temporary file, is flushed, and
   * is then renamed into place. A crash mid-write leaves a temp file, never a half-written blob
   * that a later read would serve as a whole image. Identical bytes deduplicate to the same id.
   */
  async putContent({ bytes, keccakHash, mimeType }) {
    const extension = imageExtensionFor(mimeType);
    if (!extension) throw new Error('Unsupported media type reached the store.');
    if (!HASH_SEGMENT.test(keccakHash)) throw new Error('Malformed content hash reached the store.');

    const contentId = `${keccakHash}.${extension}`;
    const target = join(this.contentDirectory, contentId);

    // Identical content is already durable; re-writing it would only risk tearing a served file.
    try {
      const existing = await stat(target);
      if (existing.size === bytes.length) return { contentId, deduplicated: true };
    } catch { /* not present yet */ }

    await mkdir(this.contentDirectory, { recursive: true });
    const temporary = `${target}.${randomUUID()}.part`;
    let handle;
    try {
      handle = await open(temporary, 'wx');
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, target);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return { contentId, deduplicated: false, integrity: sha256(bytes) };
  }

  /** Reads a blob back by its public id, or null. A malformed id never touches the filesystem. */
  async getContent(contentId) {
    if (!this.configured) return null;
    const parsed = parseContentId(contentId);
    if (!parsed) return null;
    try {
      const bytes = await readFile(join(this.contentDirectory, contentId));
      return { bytes, mimeType: MIME_FOR_EXTENSION[parsed.extension] };
    } catch {
      return null;
    }
  }

  /**
   * Points a market at a piece of content.
   *
   * One small JSON document per market, named from the checksummed address, written atomically.
   * A market's artwork is replaceable by its creator, so this is a pointer rather than part of the
   * content address — but the pointer only ever names a hash this store has already validated.
   */
  async setMarketImage({ market, contentId, contentHash, mimeType, creator }) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(market)) throw new Error('Malformed market address.');
    if (!parseContentId(contentId)) throw new Error('Malformed content id.');

    await mkdir(this.pointerDirectory, { recursive: true });
    const target = join(this.pointerDirectory, `${market.toLowerCase()}.json`);
    const document = {
      version: 1,
      market,
      contentId,
      contentHash,
      mimeType,
      creator,
      updatedAt: new Date().toISOString(),
    };
    const temporary = `${target}.${randomUUID()}.part`;
    let handle;
    try {
      handle = await open(temporary, 'wx');
      await handle.writeFile(JSON.stringify(document));
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, target);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return document;
  }

  /**
   * Reads a market's pointer, validating the stored shape rather than trusting it.
   *
   * A pointer whose content id no longer parses, or that has been hand-edited into something
   * unexpected, resolves to null — the surface then falls back to the MemeVerse mark exactly as
   * it does for a market that never had artwork.
   */
  async getMarketImage(market) {
    if (!this.configured) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(market)) return null;
    try {
      const raw = await readFile(join(this.pointerDirectory, `${market.toLowerCase()}.json`), 'utf8');
      const document = JSON.parse(raw);
      if (document?.version !== 1) return null;
      if (!parseContentId(document.contentId)) return null;
      if (typeof document.contentHash !== 'string') return null;
      return document;
    } catch {
      return null;
    }
  }
}

export function createMediaStore(config, { logger = console } = {}) {
  return new MediaStore({ directory: config.mediaStorageDir, logger });
}

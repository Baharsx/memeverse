import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import { getAddress, keccak256 } from 'viem';
import { detectImageType, parseContentId } from '../infrastructure/media-store.js';
import {
  MAX_IMAGE_BYTES,
  mediaAuthorizationExpiry,
  mediaAuthorizationExpiryState,
  mediaAuthorizationMessage,
} from '../../src/media-authorization.js';
import { startTestApp } from './helpers/app.js';
import {
  creatorAccount,
  createTestMediaService,
  gifFixture,
  htmlFixture,
  jpegFixture,
  pngFixture,
  signedUpload,
  strangerAccount,
  stubCollector,
  svgFixture,
  testChainId,
  testMarket,
  unregisteredMarket,
  uploadRequest,
  webpFixture,
} from './helpers/media.js';

/**
 * Creator media upload security.
 *
 * Every test here is written from the attacker's side: the question is never "does a good upload
 * work" but "which single thing can I change and still get bytes attached to a market I do not
 * own". Each case corrupts exactly one field of an otherwise perfectly valid request.
 */

/** Boots an app with an isolated temporary media directory and tears it down afterwards. */
async function withMediaApp(t, { collector = stubCollector() } = {}) {
  const media = await createTestMediaService({ collector });
  const app = await startTestApp({ mediaService: media.service });
  t.after(async () => {
    await app.close();
    await media.cleanup();
  });
  return { ...app, ...media };
}

test('a creator can attach a PNG, JPEG, or WebP to their own market', async (t) => {
  for (const [label, bytes, mime] of [
    ['PNG', pngFixture(), 'image/png'],
    ['JPEG', jpegFixture(), 'image/jpeg'],
    ['WebP', webpFixture(), 'image/webp'],
  ]) {
    const app = await withMediaApp(t);
    const upload = await signedUpload({ bytes, declaredMimeType: mime });
    const response = await uploadRequest(app.baseUrl, upload);
    assert.equal(response.status, 201, `${label} upload should be accepted`);

    const { data } = await response.json();
    assert.equal(data.market, testMarket);
    assert.equal(data.creator, creatorAccount.address);
    assert.equal(data.mimeType, mime);
    assert.equal(data.contentHash, keccak256(bytes).toLowerCase());
    // The public identifier is the hash of the bytes and nothing else.
    assert.ok(data.contentId.startsWith(`${data.contentHash.slice(2)}.`));
    assert.equal(data.url, `/api/v1/media/content/${data.contentId}`);
  }
});

test('stored bytes are served back byte-identical, immutable, and nosniff', async (t) => {
  const app = await withMediaApp(t);
  const bytes = pngFixture();
  const upload = await signedUpload({ bytes });
  const { data } = await (await uploadRequest(app.baseUrl, upload)).json();

  const read = await fetch(`${app.baseUrl}${data.url}`);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'image/png');
  assert.equal(read.headers.get('x-content-type-options'), 'nosniff');
  assert.match(read.headers.get('cache-control'), /immutable/);
  assert.equal(read.headers.get('content-disposition'), 'inline');
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes);
});

test('the served MIME comes from the verified bytes, not the uploader', async (t) => {
  const app = await withMediaApp(t);
  // Uploaded as a genuine WebP; the response type must be image/webp regardless of anything the
  // client could later ask for.
  const upload = await signedUpload({ bytes: webpFixture(), declaredMimeType: 'image/webp' });
  const { data } = await (await uploadRequest(app.baseUrl, upload)).json();
  const read = await fetch(`${app.baseUrl}${data.url}`);
  assert.equal(read.headers.get('content-type'), 'image/webp');
});

test('an empty body is rejected', async (t) => {
  const app = await withMediaApp(t);
  const upload = await signedUpload({ bytes: Buffer.alloc(0) });
  const response = await uploadRequest(app.baseUrl, upload);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'MEDIA_EMPTY');
});

test('an oversized image is rejected before it is stored', async (t) => {
  const app = await withMediaApp(t);
  // A real PNG header followed by enough padding to pass the 5 MB product limit.
  const oversized = Buffer.concat([pngFixture(), Buffer.alloc(MAX_IMAGE_BYTES, 0x41)]);
  const upload = await signedUpload({ bytes: oversized });
  const response = await uploadRequest(app.baseUrl, upload);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'MEDIA_TOO_LARGE');
  assert.deepEqual(await readdir(app.store.contentDirectory).catch(() => []), []);
});

test('a body past the transport limit fails closed as 413, never as a 500', async (t) => {
  const app = await withMediaApp(t);
  const enormous = Buffer.concat([pngFixture(), Buffer.alloc(7 * 1024 * 1024, 0x41)]);
  const upload = await signedUpload({ bytes: enormous });
  const response = await uploadRequest(app.baseUrl, upload);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'MEDIA_TOO_LARGE');
});

test('a body that is not the JSON it claims to be is a 400, never a 500', async (t) => {
  const app = await withMediaApp(t);
  const response = await fetch(`${app.baseUrl}/api/v1/media/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
    body: pngFixture(),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'MALFORMED_BODY');
});

test('an upload carrying correct bytes but a forged signature is refused as unauthorized', async (t) => {
  const app = await withMediaApp(t);
  const bytes = pngFixture();
  // Everything checkable without a wallet is correct — real PNG, honest type, matching hash, live
  // expiry. The only thing wrong is that nobody actually signed it.
  const upload = await signedUpload({ bytes });
  const response = await uploadRequest(app.baseUrl, {
    ...upload,
    signature: `0x${'ab'.repeat(65)}`,
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'MEDIA_SIGNATURE_INVALID');
  assert.deepEqual(await readdir(app.store.contentDirectory).catch(() => []), []);
});

test('formats outside the raster allowlist are rejected by their bytes', async (t) => {
  const cases = [
    ['SVG declared as PNG', svgFixture(), 'image/png', 'MEDIA_CONTENT_INVALID'],
    ['GIF declared as PNG', gifFixture(), 'image/png', 'MEDIA_CONTENT_INVALID'],
    ['HTML renamed to PNG', htmlFixture(), 'image/png', 'MEDIA_CONTENT_INVALID'],
    ['random binary', Buffer.alloc(64, 0x7f), 'image/png', 'MEDIA_CONTENT_INVALID'],
  ];
  for (const [label, bytes, mime, expected] of cases) {
    const app = await withMediaApp(t);
    const upload = await signedUpload({ bytes, declaredMimeType: mime });
    const response = await uploadRequest(app.baseUrl, upload);
    assert.equal(response.status, 415, label);
    assert.equal((await response.json()).error.code, expected, label);
    assert.deepEqual(await readdir(app.store.contentDirectory).catch(() => []), [], label);
  }
});

test('an SVG declared honestly is refused at the transport, so it never reaches storage', async (t) => {
  const app = await withMediaApp(t);
  const upload = await signedUpload({ bytes: svgFixture() });
  const response = await fetch(`${app.baseUrl}/api/v1/media/uploads`, {
    method: 'POST',
    headers: {
      'content-type': 'image/svg+xml',
      origin: 'http://127.0.0.1:5173',
      'x-memeverse-action': upload.action,
      'x-memeverse-market': upload.market,
      'x-memeverse-content-hash': upload.contentHash,
      'x-memeverse-expires-at': upload.expiresAt,
      'x-memeverse-signature': upload.signature,
    },
    body: upload.bytes,
  });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, 'MEDIA_TYPE_UNSUPPORTED');
});

test('real image bytes under a mismatched declared type are rejected', async (t) => {
  const app = await withMediaApp(t);
  // Genuine PNG bytes, but the client claims JPEG. Both the claim and the content are valid in
  // isolation; the disagreement is the defect.
  const upload = await signedUpload({ bytes: pngFixture(), declaredMimeType: 'image/jpeg' });
  const response = await uploadRequest(app.baseUrl, upload);
  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, 'MEDIA_TYPE_MISMATCH');
});

test('truncated and malformed containers are rejected', async (t) => {
  const truncatedPng = pngFixture().subarray(0, 10);
  const headerOnlyPng = pngFixture().subarray(0, 14);
  const truncatedJpeg = jpegFixture().subarray(0, jpegFixture().length - 2);
  const shortWebp = webpFixture().subarray(0, 14);

  // A WebP whose RIFF header claims far more data than actually arrived.
  const lyingWebp = Buffer.from(webpFixture());
  lyingWebp.writeUInt32LE(9_000, 4);

  // A RIFF/WEBP container with no recognised VP8 chunk.
  const chunklessWebp = (() => {
    const payload = Buffer.concat([
      Buffer.from('WEBP', 'latin1'), Buffer.from('XXXX', 'latin1'), Buffer.alloc(8, 0),
    ]);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(payload.length, 0);
    return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, payload]);
  })();

  for (const [label, bytes] of [
    ['truncated PNG', truncatedPng],
    ['PNG signature without IHDR', headerOnlyPng],
    ['JPEG without EOI', truncatedJpeg],
    ['short WebP', shortWebp],
    ['WebP with an overstated RIFF size', lyingWebp],
    ['WebP without a VP8 chunk', chunklessWebp],
  ]) {
    assert.equal(detectImageType(bytes), null, label);
  }
});

test('a signature is required and must be well formed', async (t) => {
  const app = await withMediaApp(t);
  const valid = await signedUpload();

  for (const [label, signature] of [
    ['missing', undefined],
    ['empty', ''],
    ['not hex', '0xnot-a-signature'],
    ['too short', `0x${'ab'.repeat(32)}`],
    ['truncated by one byte', valid.signature.slice(0, -2)],
  ]) {
    const response = await uploadRequest(app.baseUrl, { ...valid, signature });
    assert.equal(response.status, 401, label);
    assert.equal((await response.json()).error.code, 'MEDIA_SIGNATURE_INVALID', label);
  }
});

test('a signature over different bytes cannot be transplanted onto new content', async (t) => {
  const app = await withMediaApp(t);
  const authorized = pngFixture({ seed: 1 });
  const substituted = pngFixture({ seed: 2 });
  assert.notDeepEqual(authorized, substituted, 'fixtures must actually differ');

  // A perfectly valid authorization for `authorized`, sent with `substituted` in the body.
  const upload = await signedUpload({ bytes: authorized });
  const response = await uploadRequest(app.baseUrl, { ...upload, bytes: substituted });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'MEDIA_HASH_MISMATCH');
  assert.deepEqual(await readdir(app.store.contentDirectory).catch(() => []), []);
});

test('a declared hash that describes neither the signature nor the bytes is rejected', async (t) => {
  const app = await withMediaApp(t);
  const upload = await signedUpload();
  const response = await uploadRequest(app.baseUrl, {
    ...upload,
    contentHash: `0x${'11'.repeat(32)}`,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'MEDIA_HASH_MISMATCH');
});

test('an expired authorization is refused', async (t) => {
  const app = await withMediaApp(t);
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  const upload = await signedUpload({ expiresAt });
  const response = await uploadRequest(app.baseUrl, upload);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, 'MEDIA_AUTHORIZATION_EXPIRED');
  assert.equal(body.error.details.reason, 'EXPIRED');
});

test('a far-future authorization is refused, so a signature cannot be banked', async (t) => {
  const app = await withMediaApp(t);
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const upload = await signedUpload({ expiresAt });
  const response = await uploadRequest(app.baseUrl, upload);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.details.reason, 'TOO_DISTANT');
});

test('the expiry window is bounded at both ends', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const within = new Date(now.getTime() + 60_000).toISOString();
  const distant = new Date(now.getTime() + 60 * 60_000).toISOString();
  assert.equal(mediaAuthorizationExpiryState(within, now), 'VALID');
  assert.equal(mediaAuthorizationExpiryState(distant, now), 'TOO_DISTANT');
  assert.equal(mediaAuthorizationExpiryState(now.toISOString(), now), 'EXPIRED');
  assert.equal(mediaAuthorizationExpiryState('not a date', now), 'INVALID');
  assert.equal(mediaAuthorizationExpiryState(mediaAuthorizationExpiry(now), now), 'VALID');
});

test('a wallet that did not create the market cannot attach media to it', async (t) => {
  const app = await withMediaApp(t);
  const upload = await signedUpload({ account: strangerAccount });
  const response = await uploadRequest(app.baseUrl, upload);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'MEDIA_NOT_CREATOR');
  assert.deepEqual(await readdir(app.store.contentDirectory).catch(() => []), []);
});

test('a market the trusted factory does not know is refused', async (t) => {
  const app = await withMediaApp(t);
  const upload = await signedUpload({ market: unregisteredMarket });
  const response = await uploadRequest(app.baseUrl, upload);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'MARKET_NOT_REGISTERED');
});

test('a malformed market address never reaches the chain', async (t) => {
  const collector = stubCollector();
  const app = await withMediaApp(t, { collector });
  for (const market of ['not-an-address', '0x123', '0x0000000000000000000000000000000000000000']) {
    const upload = await signedUpload();
    const response = await uploadRequest(app.baseUrl, { ...upload, market });
    assert.equal(response.status, 400, market);
    assert.equal((await response.json()).error.code, 'MEDIA_MARKET_INVALID', market);
  }
  assert.deepEqual(collector.calls, [], 'no RPC should be issued for a malformed address');
});

test('a signature bound to another chain does not authorize an Arc upload', async (t) => {
  const app = await withMediaApp(t);
  // Signed over chain 1; the server always rebuilds the message with its configured Arc chain.
  const upload = await signedUpload({ signMessageAs: { chainId: 1 } });
  const response = await uploadRequest(app.baseUrl, upload);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'MEDIA_NOT_CREATOR');
});

test('a signature bound to another market does not authorize this one', async (t) => {
  const app = await withMediaApp(t);
  const upload = await signedUpload({
    signMessageAs: { market: getAddress('0x3333333333333333333333333333333333333333') },
  });
  const response = await uploadRequest(app.baseUrl, upload);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'MEDIA_NOT_CREATOR');
});

test('the two media actions are domain separated in both directions', async (t) => {
  const app = await withMediaApp(t);

  // A MARKET_AVATAR signature replayed as an NFT_MEDIA upload.
  const avatarSignature = await signedUpload({ signMessageAs: { action: 'MARKET_AVATAR' } });
  const asNft = await uploadRequest(app.baseUrl, { ...avatarSignature, action: 'NFT_MEDIA' });
  assert.equal(asNft.status, 403);
  assert.equal((await asNft.json()).error.code, 'MEDIA_NOT_CREATOR');

  // And an NFT_MEDIA signature replayed as a market avatar.
  const nftSignature = await signedUpload({
    action: 'NFT_MEDIA', signMessageAs: { action: 'NFT_MEDIA' },
  });
  const asAvatar = await uploadRequest(app.baseUrl, { ...nftSignature, action: 'MARKET_AVATAR' });
  assert.equal(asAvatar.status, 403);
  assert.equal((await asAvatar.json()).error.code, 'MEDIA_NOT_CREATOR');
});

test('an unknown action is rejected outright', async (t) => {
  const app = await withMediaApp(t);
  const upload = await signedUpload();
  const response = await uploadRequest(app.baseUrl, { ...upload, action: 'DRAIN_TREASURY' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'MEDIA_ACTION_INVALID');
});

test('an NFT_MEDIA upload stores content without touching the market avatar pointer', async (t) => {
  const app = await withMediaApp(t);
  const upload = await signedUpload({
    action: 'NFT_MEDIA', signMessageAs: { action: 'NFT_MEDIA' },
  });
  const response = await uploadRequest(app.baseUrl, upload);
  assert.equal(response.status, 201);
  // The bytes are hosted, but the market's public artwork is untouched: these are different acts.
  assert.equal(await app.store.getMarketImage(testMarket), null);
});

test('uploading identical bytes twice is idempotent', async (t) => {
  const app = await withMediaApp(t);
  const bytes = pngFixture();

  const first = await (await uploadRequest(app.baseUrl, await signedUpload({ bytes }))).json();
  const second = await (await uploadRequest(app.baseUrl, await signedUpload({ bytes }))).json();

  assert.equal(first.data.contentId, second.data.contentId);
  assert.equal(second.data.deduplicated, true);
  const stored = await readdir(app.store.contentDirectory);
  assert.equal(stored.length, 1, 'identical content must occupy one file');
});

test('a creator can replace their market image, and the pointer follows', async (t) => {
  const app = await withMediaApp(t);
  const original = pngFixture({ seed: 1 });
  const replacement = pngFixture({ seed: 2 });

  const first = await (await uploadRequest(app.baseUrl, await signedUpload({ bytes: original }))).json();
  const lookupBefore = await (await fetch(`${app.baseUrl}/api/v1/media/markets?markets=${testMarket}`)).json();
  assert.equal(lookupBefore.data[testMarket].contentId, first.data.contentId);

  const second = await (await uploadRequest(app.baseUrl, await signedUpload({ bytes: replacement }))).json();
  assert.notEqual(second.data.contentId, first.data.contentId);

  const lookupAfter = await (await fetch(`${app.baseUrl}/api/v1/media/markets?markets=${testMarket}`)).json();
  assert.equal(lookupAfter.data[testMarket].contentId, second.data.contentId);

  // The superseded bytes remain individually addressable, so any NFT that committed to them
  // keeps resolving. Replacement moves a pointer; it does not rewrite history.
  const old = await fetch(`${app.baseUrl}${first.data.url}`);
  assert.equal(old.status, 200);
});

test('a stranger cannot replace a market image the creator already set', async (t) => {
  const app = await withMediaApp(t);
  const owned = await (await uploadRequest(app.baseUrl, await signedUpload())).json();

  const hostile = await signedUpload({
    bytes: pngFixture({ seed: 9 }), account: strangerAccount,
  });
  const response = await uploadRequest(app.baseUrl, hostile);
  assert.equal(response.status, 403);

  const lookup = await (await fetch(`${app.baseUrl}/api/v1/media/markets?markets=${testMarket}`)).json();
  assert.equal(lookup.data[testMarket].contentId, owned.data.contentId, 'pointer must be unchanged');
});

test('a cross-origin upload is blocked before any work happens', async (t) => {
  const collector = stubCollector();
  const app = await withMediaApp(t, { collector });
  const upload = await signedUpload();

  const foreign = await uploadRequest(app.baseUrl, upload, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error.code, 'CROSS_ORIGIN_BLOCKED');

  const originless = await uploadRequest(app.baseUrl, upload, { origin: null });
  assert.equal(originless.status, 403);
  assert.equal((await originless.json()).error.code, 'ORIGIN_REQUIRED');

  assert.deepEqual(collector.calls, [], 'a blocked origin must not cause an RPC');
});

test('a content id cannot describe a path', () => {
  const traversals = [
    '../../../../etc/passwd',
    '..%2f..%2fetc%2fpasswd',
    `${'a'.repeat(64)}.png/../../secret`,
    '/etc/passwd',
    `${'a'.repeat(64)}.png\0.txt`,
    `${'a'.repeat(64)}..png`,
    `${'a'.repeat(63)}g.png`,
    `${'A'.repeat(64)}.png`,
    `${'a'.repeat(64)}.svg`,
    `${'a'.repeat(64)}.php`,
    `${'a'.repeat(64)}`,
    '.',
    '..',
  ];
  for (const candidate of traversals) {
    assert.equal(parseContentId(candidate), null, candidate);
  }
  assert.deepEqual(parseContentId(`${'a'.repeat(64)}.png`), { hash: 'a'.repeat(64), extension: 'png' });
});

test('traversal in a content id yields a plain 404 and never reads outside the store', async (t) => {
  const app = await withMediaApp(t);
  for (const candidate of [
    '..%2f..%2f..%2fetc%2fpasswd',
    '%2e%2e%2f%2e%2e%2fpackage.json',
    'not-a-hash.png',
    `${'a'.repeat(64)}.png`,
  ]) {
    const response = await fetch(`${app.baseUrl}/api/v1/media/content/${candidate}`);
    assert.equal(response.status, 404, candidate);
    const body = await response.json();
    assert.equal(body.error.code, 'MEDIA_NOT_FOUND', candidate);
    // No path, no directory, no stack — nothing that describes the filesystem.
    assert.ok(!JSON.stringify(body).includes('/'), `response leaked a path for ${candidate}`);
  }
});

test('an uploaded filename can never influence the storage path', async (t) => {
  const app = await withMediaApp(t);
  const bytes = pngFixture();
  const upload = await signedUpload({ bytes });

  // The transport carries no filename at all, but a client may still try to smuggle one.
  const response = await fetch(`${app.baseUrl}/api/v1/media/uploads`, {
    method: 'POST',
    headers: {
      'content-type': 'image/png',
      origin: 'http://127.0.0.1:5173',
      'content-disposition': 'attachment; filename="../../../../tmp/owned.png"',
      'x-memeverse-action': upload.action,
      'x-memeverse-market': upload.market,
      'x-memeverse-content-hash': upload.contentHash,
      'x-memeverse-expires-at': upload.expiresAt,
      'x-memeverse-signature': upload.signature,
    },
    body: bytes,
  });
  assert.equal(response.status, 201);

  const stored = await readdir(app.store.contentDirectory);
  assert.deepEqual(stored, [`${keccak256(bytes).slice(2)}.png`]);
});

test('no API response ever discloses the storage location', async (t) => {
  const app = await withMediaApp(t);
  const upload = await signedUpload();
  const created = await uploadRequest(app.baseUrl, upload);
  const payloads = [
    JSON.stringify(await created.json()),
    JSON.stringify(await (await fetch(`${app.baseUrl}/api/v1/media/markets?markets=${testMarket}`)).json()),
    JSON.stringify(await (await fetch(`${app.baseUrl}/api/health`)).json()),
  ];
  for (const payload of payloads) {
    assert.ok(!payload.includes(app.directory), 'a response disclosed the media directory');
    assert.ok(!payload.includes('/tmp/'), 'a response disclosed a filesystem path');
  }
});

test('the market lookup validates, bounds, and deduplicates its input', async (t) => {
  const app = await withMediaApp(t);
  await uploadRequest(app.baseUrl, await signedUpload());

  const mixedCase = testMarket.toLowerCase();
  const query = [testMarket, mixedCase, 'garbage', '', unregisteredMarket].join(',');
  const response = await fetch(`${app.baseUrl}/api/v1/media/markets?markets=${query}`);
  assert.equal(response.status, 200);

  const { data } = await response.json();
  assert.deepEqual(Object.keys(data), [testMarket], 'only known, checksummed markets appear');
  // Presentation metadata only: no signature, no creator wallet, no storage internals.
  assert.deepEqual(
    Object.keys(data[testMarket]).sort(),
    ['contentHash', 'contentId', 'mimeType', 'updatedAt', 'url'],
  );

  const empty = await fetch(`${app.baseUrl}/api/v1/media/markets`);
  assert.deepEqual((await empty.json()).data, {});
});

test('a market with no image is absent rather than an error', async (t) => {
  const app = await withMediaApp(t);
  const response = await fetch(`${app.baseUrl}/api/v1/media/markets?markets=${testMarket}`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {});
});

test('a pointer whose content no longer parses resolves to no image', async (t) => {
  const app = await withMediaApp(t);
  await uploadRequest(app.baseUrl, await signedUpload());

  // Simulates a hand-edited or corrupted index entry.
  await app.store.setMarketImage({
    market: testMarket,
    contentId: `${'a'.repeat(64)}.png`,
    contentHash: `0x${'a'.repeat(64)}`,
    mimeType: 'image/png',
    creator: creatorAccount.address,
  }).catch(() => undefined);
  const document = await app.store.getMarketImage(testMarket);
  // The shape is valid, so it resolves; the bytes are simply missing and the read 404s.
  assert.ok(document);
  const read = await fetch(`${app.baseUrl}/api/v1/media/content/${document.contentId}`);
  assert.equal(read.status, 404);
});

test('media stays unavailable rather than half-working when it is not configured', async (t) => {
  const app = await startTestApp({ mediaService: undefined });
  t.after(() => app.close());

  const upload = await signedUpload();
  const response = await uploadRequest(app.baseUrl, upload);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'MEDIA_NOT_AVAILABLE');

  // And the product is still healthy: media is presentation, not a financial dependency.
  const health = await fetch(`${app.baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.media.status, 'NOT_CONFIGURED');
});

test('health reports media readiness without revealing where it lives', async (t) => {
  const app = await withMediaApp(t);
  const body = await (await fetch(`${app.baseUrl}/api/health`)).json();
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.media, { configured: true, status: 'READY' });
});

test('the canonical message binds every security-relevant field', () => {
  const expiresAt = '2026-01-01T00:00:00.000Z';
  const contentHash = `0x${'ab'.repeat(32)}`;
  const base = {
    action: 'MARKET_AVATAR', chainId: testChainId, market: testMarket, contentHash, expiresAt,
  };
  const message = mediaAuthorizationMessage(base);

  assert.match(message, /^MemeVerse Media Authorization\n/);
  assert.ok(message.includes(`Chain ID: ${testChainId}`));
  assert.ok(message.includes(`Market: ${testMarket}`));
  assert.ok(message.includes(`Content Hash: ${contentHash}`));
  assert.ok(message.includes('Action: MARKET_AVATAR'));
  assert.ok(message.includes(`Expires At: ${expiresAt}`));
  // The wallet prompt must state plainly that nothing financial is being approved.
  assert.ok(message.includes('moves no funds'));

  // Changing any bound field changes the text a wallet signs.
  for (const change of [
    { action: 'NFT_MEDIA' },
    { chainId: 1 },
    { market: getAddress('0x4444444444444444444444444444444444444444') },
    { contentHash: `0x${'cd'.repeat(32)}` },
    { expiresAt: '2026-01-01T00:05:00.000Z' },
  ]) {
    assert.notEqual(mediaAuthorizationMessage({ ...base, ...change }), message);
  }

  // A lowercase market address normalizes to the same checksummed text, so a wallet that
  // lowercases an address still produces a recoverable signature.
  assert.equal(
    mediaAuthorizationMessage({ ...base, market: testMarket.toLowerCase() }),
    message,
  );
});

test('the canonical message refuses to be built from unusable input', () => {
  const valid = {
    action: 'MARKET_AVATAR',
    chainId: testChainId,
    market: testMarket,
    contentHash: `0x${'ab'.repeat(32)}`,
    expiresAt: '2026-01-01T00:00:00.000Z',
  };
  for (const change of [
    { action: 'UNKNOWN' },
    { action: 'toString' },
    { market: 'nope' },
    { contentHash: 'nope' },
    { chainId: 1.5 },
    { expiresAt: 'nope' },
  ]) {
    assert.throws(() => mediaAuthorizationMessage({ ...valid, ...change }), Error);
  }
});

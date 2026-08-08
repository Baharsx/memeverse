import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { detectImageType } from '../../src/image-signature.js';
import {
  IMAGE_ACCEPT_ATTRIBUTE,
  canStartMediaUpload,
  formatImageSize,
  initialMediaUploadState,
  isMediaUploadBusy,
  mediaAuthorizationKey,
  mediaUploadErrorMessage,
  mediaUploadReducer,
  validateImageBytes,
  validateImageFile,
} from '../../src/media-upload.js';
import { MAX_IMAGE_BYTES } from '../../src/media-authorization.js';
import {
  gifFixture, htmlFixture, jpegFixture, pngFixture, svgFixture, webpFixture,
} from './helpers/media.js';

/**
 * Browser-side media logic.
 *
 * The properties guarded here are the ones that decide whether the interface can lie to a
 * creator: that the state machine cannot represent "signed but the file changed", that a preview
 * and a hash always describe the same bytes, and that a rejected file is rejected before a wallet
 * prompt rather than after.
 */

test('the upload state machine only advances along legal transitions', () => {
  const ready = mediaUploadReducer(initialMediaUploadState, { type: 'SELECT' });
  assert.equal(ready.status, 'VALIDATING');

  const validated = mediaUploadReducer(ready, { type: 'VALIDATED' });
  assert.equal(validated.status, 'READY');

  const signing = mediaUploadReducer(validated, { type: 'SIGN' });
  assert.equal(signing.status, 'AWAITING_SIGNATURE');

  const uploading = mediaUploadReducer(signing, { type: 'UPLOAD' });
  assert.equal(uploading.status, 'UPLOADING');

  const done = mediaUploadReducer(uploading, { type: 'SUCCESS', result: { contentId: 'x' } });
  assert.equal(done.status, 'UPLOADED');
  assert.deepEqual(done.result, { contentId: 'x' });
});

test('the state machine refuses to skip the signature or the upload', () => {
  // Uploading without having asked for a signature.
  assert.equal(mediaUploadReducer({ status: 'READY' }, { type: 'UPLOAD' }).status, 'READY');
  // Succeeding without having uploaded.
  assert.equal(
    mediaUploadReducer({ status: 'AWAITING_SIGNATURE' }, { type: 'SUCCESS' }).status,
    'AWAITING_SIGNATURE',
  );
  // Starting a second attempt while one is in flight — the double-click case.
  for (const status of ['VALIDATING', 'AWAITING_SIGNATURE', 'UPLOADING']) {
    assert.equal(mediaUploadReducer({ status }, { type: 'SIGN' }).status, status);
    assert.equal(isMediaUploadBusy(status), true);
    assert.equal(canStartMediaUpload(status), false);
  }
});

test('a failed upload can be retried but a finished one cannot be repeated', () => {
  assert.equal(canStartMediaUpload('FAILED'), true);
  assert.equal(canStartMediaUpload('READY'), true);
  assert.equal(canStartMediaUpload('UPLOADED'), false);
  assert.equal(mediaUploadReducer({ status: 'UPLOADED' }, { type: 'SIGN' }).status, 'UPLOADED');
});

test('any invalidation returns the machine to a clean idle state', () => {
  const uploaded = { status: 'UPLOADED', error: null, result: { contentId: 'x' } };
  for (const type of ['INVALIDATE', 'RESET']) {
    assert.deepEqual(mediaUploadReducer(uploaded, { type }), initialMediaUploadState);
  }
  // Including from mid-flight, so switching wallet during a signature cannot leave a stale result.
  assert.deepEqual(
    mediaUploadReducer({ status: 'AWAITING_SIGNATURE' }, { type: 'INVALIDATE' }),
    initialMediaUploadState,
  );
});

test('an unknown event never mutates the state', () => {
  const state = { status: 'READY', error: null, result: null };
  assert.equal(mediaUploadReducer(state, { type: 'WAT' }), state);
  assert.deepEqual(mediaUploadReducer(undefined, {}), initialMediaUploadState);
});

test('the authorization key changes with market, content, or wallet', () => {
  const base = { market: '0xAbC', contentHash: '0x11', wallet: '0xWaLLeT' };
  const key = mediaAuthorizationKey(base);

  assert.notEqual(mediaAuthorizationKey({ ...base, market: '0xDeF' }), key);
  assert.notEqual(mediaAuthorizationKey({ ...base, contentHash: '0x22' }), key);
  assert.notEqual(mediaAuthorizationKey({ ...base, wallet: '0xOther' }), key);

  // Wallet case must not count as a change: the same account reported with different casing by a
  // provider would otherwise discard a valid authorization on every render.
  assert.equal(mediaAuthorizationKey({ ...base, wallet: '0xwallet' }), key);

  // A missing selection is its own distinct key, never accidentally equal to a real one.
  assert.notEqual(mediaAuthorizationKey({}), key);
});

test('file validation rejects everything the server would reject', () => {
  assert.equal(validateImageFile(null).ok, false);
  assert.equal(validateImageFile({ size: 0, type: 'image/png' }).ok, false);
  assert.equal(validateImageFile({ size: 10, type: 'image/gif' }).ok, false);
  assert.equal(validateImageFile({ size: 10, type: 'image/svg+xml' }).ok, false);
  assert.equal(validateImageFile({ size: 10, type: 'text/html' }).ok, false);
  assert.equal(validateImageFile({ size: MAX_IMAGE_BYTES + 1, type: 'image/png' }).ok, false);

  assert.deepEqual(validateImageFile({ size: 10, type: 'image/png' }), { ok: true, mimeType: 'image/png' });
  assert.deepEqual(validateImageFile({ size: 10, type: 'image/webp' }), { ok: true, mimeType: 'image/webp' });
  // A browser that reports the non-standard image/jpg still describes a JPEG.
  assert.deepEqual(validateImageFile({ size: 10, type: 'image/jpg' }), { ok: true, mimeType: 'image/jpeg' });
  // As does one that appends a parameter.
  assert.deepEqual(
    validateImageFile({ size: 10, type: 'image/png; charset=binary' }),
    { ok: true, mimeType: 'image/png' },
  );
});

test('the oversize message states the actual size so the limit is actionable', () => {
  const result = validateImageFile({ size: 8 * 1024 * 1024, type: 'image/png' });
  assert.equal(result.ok, false);
  assert.match(result.error, /8\.00 MB/);
  assert.match(result.error, /5 MB/);
});

test('byte validation catches a file renamed into an allowed type', () => {
  // The exact attack the picker exists to stop: an SVG or an HTML document called cat.png.
  assert.equal(validateImageBytes(svgFixture(), 'image/png').ok, false);
  assert.equal(validateImageBytes(htmlFixture(), 'image/png').ok, false);
  assert.equal(validateImageBytes(gifFixture(), 'image/png').ok, false);

  // And a genuine image whose declared type is simply wrong.
  const mismatch = validateImageBytes(pngFixture(), 'image/jpeg');
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /do not match/);

  for (const [bytes, mime] of [
    [pngFixture(), 'image/png'],
    [jpegFixture(), 'image/jpeg'],
    [webpFixture(), 'image/webp'],
  ]) {
    assert.deepEqual(validateImageBytes(bytes, mime), { ok: true, mimeType: mime });
  }
});

test('byte validation refuses input it cannot inspect', () => {
  assert.equal(validateImageBytes(null, 'image/png').ok, false);
  assert.equal(validateImageBytes(new Uint8Array(0), 'image/png').ok, false);
  assert.equal(validateImageBytes(new Uint8Array(4), 'image/png').ok, false);
});

test('the browser and the server detect formats identically', () => {
  // One implementation, imported by both — this asserts the property that makes that safe.
  for (const [bytes, expected] of [
    [pngFixture(), 'image/png'],
    [jpegFixture(), 'image/jpeg'],
    [webpFixture(), 'image/webp'],
    [svgFixture(), null],
    [gifFixture(), null],
    [htmlFixture(), null],
  ]) {
    assert.equal(detectImageType(bytes), expected);
    // Buffer is a Uint8Array; a plain one must behave the same.
    assert.equal(detectImageType(Uint8Array.from(bytes)), expected);
  }
});

test('the file input accepts exactly the three hosted formats', () => {
  assert.equal(IMAGE_ACCEPT_ATTRIBUTE.includes('image/png'), true);
  assert.equal(IMAGE_ACCEPT_ATTRIBUTE.includes('image/jpeg'), true);
  assert.equal(IMAGE_ACCEPT_ATTRIBUTE.includes('image/webp'), true);
  assert.equal(IMAGE_ACCEPT_ATTRIBUTE.includes('svg'), false);
  assert.equal(IMAGE_ACCEPT_ATTRIBUTE.includes('gif'), false);
});

test('sizes are formatted without inventing precision', () => {
  assert.equal(formatImageSize(512), '512 B');
  assert.equal(formatImageSize(2048), '2 KB');
  assert.equal(formatImageSize(5 * 1024 * 1024), '5.00 MB');
  assert.equal(formatImageSize(Number.NaN), '—');
});

test('server error codes become sentences a creator can act on', () => {
  const notCreator = mediaUploadErrorMessage({ code: 'MEDIA_NOT_CREATOR' });
  assert.match(notCreator, /different wallet/);
  assert.match(mediaUploadErrorMessage({ code: 'MEDIA_TOO_LARGE' }), /5 MB/);
  assert.match(mediaUploadErrorMessage({ code: 'MEDIA_AUTHORIZATION_EXPIRED' }), /sign a fresh one/);
  // A media outage must never read as a problem with the market or with money.
  assert.match(mediaUploadErrorMessage({ code: 'MEDIA_NOT_AVAILABLE' }), /market itself is unaffected/);
  // An unmapped failure still says something rather than rendering "undefined".
  assert.equal(mediaUploadErrorMessage({ message: 'Network down.' }), 'Network down.');
  assert.equal(typeof mediaUploadErrorMessage(undefined), 'string');
});

/**
 * Source-level guarantees.
 *
 * A few properties of these surfaces are structural rather than functional, and losing one would
 * be silent: an object URL that is never revoked leaks until the tab closes, and an onError that
 * reassigns its own src loops forever. Both are cheap to assert and expensive to rediscover.
 */
test('object URLs are revoked and the image fallback cannot loop', async () => {
  const source = await readFile(new URL('../../src/media-views.jsx', import.meta.url), 'utf8');

  assert.ok(source.includes('URL.revokeObjectURL'), 'preview URLs must be revoked');
  assert.ok(
    source.includes('useEffect(() => revokePreview, [revokePreview])'),
    'unmount must revoke the last preview URL',
  );
  // The fallback is a state flag, never a second assignment to src, so it can fire at most once.
  assert.ok(source.includes('onError={() => setFailed(true)}'), 'fallback must latch through state');
  assert.ok(!/onError[^\n]*\.src\s*=/.test(source), 'onError must not reassign src');
});

test('the launch surface keeps the image out of the Arc transaction', async () => {
  const source = await readFile(new URL('../../src/main.jsx', import.meta.url), 'utf8');

  // The factory call takes exactly the six arguments it always took, and none of them is media.
  const createMarket = /functionName: 'createMarket',\s*\n\s*args: \[([^\]]+)\]/.exec(source);
  assert.ok(createMarket, 'the createMarket call must still be present');
  const args = createMarket[1].split(',').map((argument) => argument.trim());
  assert.deepEqual(args, [
    'name.trim()',
    'symbol.trim().toUpperCase()',
    'description.trim()',
    'supplyValue',
    'basePriceUnits',
    'slopePriceUnits',
  ], 'createMarket calldata must be unchanged');
  assert.ok(
    !args.some((argument) => /image|media|hash|uri/i.test(argument)),
    'no media value may enter the launch call',
  );

  // The attach step exists and is gated on a confirmed result.
  assert.ok(source.includes('result && image.selection'), 'attach must require a confirmed market');
});

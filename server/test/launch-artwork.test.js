import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  LAUNCH_ARTWORK_STAGES,
  canRetryLaunchArtwork,
  launchArtworkStage,
  mediaUploadReducer,
} from '../../src/media-upload.js';
import { MEDIA_ACTIONS } from '../../src/media-authorization.js';

/**
 * Launch-page artwork orchestration.
 *
 * A creator picks an image once, before launching. After the market is confirmed the same bytes
 * are attached automatically. Two properties make that safe rather than merely convenient, and
 * these tests exist to keep both:
 *
 *   1. a confirmed launch is never presented as a failure because artwork did not attach — they
 *      are separate outcomes and only one of them involves money;
 *   2. the automatic attach fires exactly once for a given market and file, no matter how many
 *      times React re-renders, refetches, or double-invokes an effect.
 */

const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const launchSource = async () => {
  const text = await source('../../src/main.jsx');
  return text.slice(text.indexOf('function Launch()'), text.indexOf('function TransactionStatus'));
};

// ── 1. Launch with no image ─────────────────────────────────────────────────

test('a launch without an image has no artwork surface at all', () => {
  // Before, during, and after a launch: nothing to attach, so nothing is shown, no signature is
  // requested, and no upload is attempted.
  for (const status of ['IDLE', 'READY', 'AWAITING_SIGNATURE', 'UPLOADING', 'UPLOADED', 'FAILED']) {
    assert.equal(
      launchArtworkStage({ hasSelection: false, launched: true, status }),
      LAUNCH_ARTWORK_STAGES.NONE,
      status,
    );
  }
  assert.equal(launchArtworkStage({}), LAUNCH_ARTWORK_STAGES.NONE);
});

test('an image selected before launch shows nothing until the market is confirmed', () => {
  // No market address yet means no authorization is even expressible, so the surface stays absent
  // rather than showing a pending step the creator cannot act on.
  assert.equal(
    launchArtworkStage({ hasSelection: true, launched: false, status: 'READY' }),
    LAUNCH_ARTWORK_STAGES.NONE,
  );
});

// ── 2. Launch with a selected image ─────────────────────────────────────────

test('the artwork stage follows the upload state machine once a market exists', () => {
  const base = { hasSelection: true, launched: true, walletMatchesCreator: true };
  assert.equal(launchArtworkStage({ ...base, status: 'IDLE' }), LAUNCH_ARTWORK_STAGES.WAITING);
  assert.equal(launchArtworkStage({ ...base, status: 'READY' }), LAUNCH_ARTWORK_STAGES.WAITING);
  assert.equal(launchArtworkStage({ ...base, status: 'AWAITING_SIGNATURE' }), LAUNCH_ARTWORK_STAGES.SIGNING);
  assert.equal(launchArtworkStage({ ...base, status: 'UPLOADING' }), LAUNCH_ARTWORK_STAGES.UPLOADING);
  assert.equal(launchArtworkStage({ ...base, status: 'UPLOADED' }), LAUNCH_ARTWORK_STAGES.ATTACHED);
  assert.equal(launchArtworkStage({ ...base, status: 'FAILED' }), LAUNCH_ARTWORK_STAGES.FAILED);
});

test('the attach is bound to the confirmed market address from the launch event', async () => {
  const launch = await launchSource();

  // The address comes from the parsed MarketCreated event on the confirmed receipt — never from a
  // market list, a "latest market" lookup, or a timing assumption.
  assert.ok(launch.includes("eventName: 'MarketCreated'"), 'the launch parses its own event');
  assert.ok(/setResult\(\{ market: event\.args\.market/.test(launch), 'the market comes from that event');
  assert.ok(/market: result\?\.market/.test(launch), 'the upload binds to that exact address');

  // And the file is the one already selected on this page — not a second pick.
  assert.ok(/selection: image\.selection/.test(launch), 'the upload reuses the launch selection');
  assert.ok(launch.includes('action: MEDIA_ACTIONS.MARKET_AVATAR'), 'the existing market action is used');

  // No polling or list-scanning anywhere in the launch flow.
  assert.equal(/loadMarkets\(|marketCount|setInterval|setTimeout/.test(launch), false,
    'the new market must not be inferred by polling or by scanning a list');
});

test('the authorization action is a real one the server accepts', () => {
  // A misspelled action would be silently unsignable: the message builder rejects it and the
  // server would refuse it. MARKET_ARTWORK is not a thing; MARKET_AVATAR is.
  assert.equal(MEDIA_ACTIONS.MARKET_AVATAR, 'MARKET_AVATAR');
  assert.equal(MEDIA_ACTIONS.MARKET_ARTWORK, undefined);
});

// ── 3. No duplicate attachment ──────────────────────────────────────────────

test('the automatic attach is guarded by a market+hash key, not by callback identity', async () => {
  const launch = await launchSource();

  // The classic failure here is `useEffect(() => upload.start(), [start])` with a `start` that is
  // recreated every render — one wallet prompt per render. The effect must depend on values only.
  const effect = /useEffect\(\(\) => \{\s*if \(!autoAttachKey\) return;[\s\S]*?\}, \[([^\]]*)\]\);/.exec(launch);
  assert.ok(effect, 'the auto-attach effect exists');
  const deps = effect[1].split(',').map((d) => d.trim()).filter(Boolean);
  assert.deepEqual(deps, ['autoAttachKey', 'walletIsCreator'],
    'the effect must depend only on stable values');
  for (const unstable of ['attach.start', 'attach', 'startAttachRef.current', 'image.selection']) {
    assert.equal(deps.includes(unstable), false, `${unstable} must not be a dependency`);
  }

  // The key identifies the market and the exact bytes, and the guard is recorded before the
  // async call so a StrictMode double-invoke cannot slip through between them.
  assert.ok(/const autoAttachKey = result\?\.market && image\.selection\?\.contentHash/.test(launch),
    'the key is market + content hash');
  const body = effect[0];
  assert.ok(body.indexOf('autoAttachedRef.current = autoAttachKey')
    < body.indexOf('startAttachRef.current?.()'), 'the guard is set before the start call');
  assert.ok(body.includes('if (autoAttachedRef.current === autoAttachKey) return;'),
    'a repeat for the same market and file is refused');
});

test('the latest start callback is reached through a ref rather than a dependency', async () => {
  const launch = await launchSource();
  assert.ok(/const startAttachRef = useRef\(attach\.start\)/.test(launch));
  assert.ok(/useEffect\(\(\) => \{ startAttachRef\.current = attach\.start; \}\);/.test(launch),
    'the ref tracks the latest callback on every render');
});

// ── 4 & 5. Declined signature, and upload/API failure ───────────────────────

test('a failed attach never reports the launch as failed', async () => {
  const stage = launchArtworkStage({
    hasSelection: true, launched: true, walletMatchesCreator: true, status: 'FAILED',
  });
  assert.equal(stage, LAUNCH_ARTWORK_STAGES.FAILED);

  const launch = await launchSource();
  // The failure headline still leads with the launch having succeeded.
  assert.ok(launch.includes("'MARKET LAUNCHED // ARTWORK NOT ATTACHED'"));
  assert.ok(launch.includes("'MARKET LAUNCHED // ARTWORK ATTACHED'"));
  // And the launch receipt is a separate element that renders on `result` alone.
  assert.ok(launch.includes('<b>MARKET CONFIRMED ON ARC</b>'), 'the launch receipt is independent');
  assert.equal(/LAUNCH FAILED|launch failed/i.test(launch), false,
    'artwork failure must never be worded as a launch failure');
});

test('a failure offers a retry, and a success and in-flight states do not', () => {
  assert.equal(canRetryLaunchArtwork(LAUNCH_ARTWORK_STAGES.FAILED), true);
  assert.equal(canRetryLaunchArtwork(LAUNCH_ARTWORK_STAGES.WRONG_WALLET), true);
  for (const stage of ['NONE', 'WAITING', 'SIGNING', 'UPLOADING', 'ATTACHED']) {
    assert.equal(canRetryLaunchArtwork(LAUNCH_ARTWORK_STAGES[stage]), false, stage);
  }
});

test('retry reuses the selected file and never relaunches or re-picks', async () => {
  const launch = await launchSource();
  const retry = /function retryArtwork\(\)[\s\S]*?\n  \}/.exec(launch);
  assert.ok(retry, 'a retry handler exists');

  // It calls the same upload start with the same selection already in memory.
  assert.ok(retry[0].includes('startAttachRef.current?.()'));
  // It must not launch anything, clear the selection, or ask for a file again.
  for (const forbidden of ['launchMarket', 'image.clear', 'image.select', 'action.execute', 'setResult']) {
    assert.equal(retry[0].includes(forbidden), false, `retry must not call ${forbidden}`);
  }

  // The selection is never cleared on launch success, so the bytes survive for a retry.
  assert.equal(/image\.clear\(\)/.test(launch), false,
    'the launch flow must not discard the selection the retry depends on');
});

// ── H. Wallet safety ────────────────────────────────────────────────────────

test('a wallet that is not the creator is never prompted automatically', async () => {
  assert.equal(
    launchArtworkStage({
      hasSelection: true, launched: true, walletMatchesCreator: false, status: 'IDLE',
    }),
    LAUNCH_ARTWORK_STAGES.WRONG_WALLET,
  );

  const launch = await launchSource();
  assert.ok(/const walletIsCreator = Boolean\(address && result\?\.creator/.test(launch),
    'creator identity is compared explicitly');
  assert.ok(/address\.toLowerCase\(\) === result\.creator\.toLowerCase\(\)/.test(launch),
    'the comparison is case-insensitive, as addresses require');
  // The effect refuses to start for a non-creator wallet.
  assert.ok(/if \(!walletIsCreator\) return;/.test(launch), 'auto-attach is gated on the creator');
  // And so is the manual retry.
  const retry = /function retryArtwork\(\)[\s\S]*?\n  \}/.exec(launch);
  assert.ok(retry[0].includes('!walletIsCreator'), 'retry is gated on the creator too');
});

test('an in-flight state is never mistaken for a finished one', () => {
  const base = { hasSelection: true, launched: true, walletMatchesCreator: true };
  // Nothing may read as attached until the upload actually reported success.
  for (const status of ['IDLE', 'READY', 'AWAITING_SIGNATURE', 'UPLOADING', 'FAILED']) {
    assert.notEqual(launchArtworkStage({ ...base, status }), LAUNCH_ARTWORK_STAGES.ATTACHED, status);
  }
  assert.equal(launchArtworkStage({ ...base, status: 'UPLOADED' }), LAUNCH_ARTWORK_STAGES.ATTACHED);
});

// ── F. Success behaviour ────────────────────────────────────────────────────

test('a successful attach refreshes the surfaces that render the new artwork', async () => {
  const launch = await launchSource();
  const onUploaded = /onUploaded: \(\) => \{[\s\S]*?\},/.exec(launch);
  assert.ok(onUploaded, 'the upload reports success back to the page');
  assert.ok(onUploaded[0].includes("queryKey: ['market-images']"), 'artwork is refetched');
  assert.ok(onUploaded[0].includes("queryKey: ['onchain-markets']"), 'the market list is refetched');
});

// ── 6. The existing manual flow is untouched ────────────────────────────────

test('the manual artwork control for existing markets is unchanged', async () => {
  const text = await source('../../src/main.jsx');
  const manager = text.slice(text.indexOf('function MarketImageManager'), text.indexOf('function Markets()'));

  // Still creator-gated, still its own picker, still an explicit button — no auto-start anywhere.
  assert.ok(manager.includes('const isCreator = address && market.creator'));
  assert.ok(manager.includes('if (!isCreator) return null;'));
  assert.ok(manager.includes('<ImagePicker'), 'it keeps its own file picker');
  assert.ok(manager.includes('<AttachImageButton'), 'it keeps its explicit attach button');
  assert.ok(manager.includes('action: MEDIA_ACTIONS.MARKET_AVATAR'));
  assert.equal(/autoAttach|startAttachRef/.test(manager), false,
    'the manual flow must not gain automatic behaviour');
});

test('the upload primitive itself is unchanged by this orchestration', async () => {
  const views = await source('../../src/media-views.jsx');
  // The security-relevant parts of the signed authorization stay exactly where they were.
  for (const required of [
    'mediaAuthorizationMessage({', 'chainId: arc.id,', 'contentHash: selection.contentHash,',
    'const signature = await signMessageAsync({ message });',
    'if (result.contentHash !== selection.contentHash) {',
    'if (inFlightRef.current || !selection || !market) return;',
  ]) {
    assert.ok(views.includes(required), `useMediaUpload must still contain: ${required}`);
  }
});

// ── The invalidation race that made the attach invisible ────────────────────

test('a dropped SIGN is exactly what an un-revalidated selection would cause', () => {
  // The reducer only starts from READY or FAILED. That rule is correct and stays.
  const ready = { status: 'READY', error: null, result: null };
  assert.equal(mediaUploadReducer(ready, { type: 'SIGN' }).status, 'AWAITING_SIGNATURE');

  // An invalidation returns the machine to IDLE, and SIGN from IDLE is refused.
  const idle = mediaUploadReducer(ready, { type: 'INVALIDATE' });
  assert.equal(idle.status, 'IDLE');
  assert.equal(mediaUploadReducer(idle, { type: 'SIGN' }).status, 'IDLE');

  // Which is why a still-present selection must be re-validated after an invalidation —
  // otherwise the upload runs on the network while the surface never leaves its waiting state.
  const revalidated = mediaUploadReducer(idle, { type: 'VALIDATED' });
  assert.equal(revalidated.status, 'READY');
  assert.equal(mediaUploadReducer(revalidated, { type: 'SIGN' }).status, 'AWAITING_SIGNATURE');
});

test('the upload hook re-validates a live selection whenever its authorization key changes', async () => {
  const views = await source('../../src/media-views.jsx');

  // On Launch the market address arrives after the file, so the key changes while the selection
  // object stays identical. Keyed on `selection` alone this effect would not re-run and the
  // machine would sit in IDLE, silently refusing to start.
  const effect = /useEffect\(\(\) => \{\s*if \(selection\) dispatch\(\{ type: 'VALIDATED' \}\);\s*\}, \[([^\]]*)\]\);/
    .exec(views);
  assert.ok(effect, 'the re-validation effect exists');
  const deps = effect[1].split(',').map((d) => d.trim()).filter(Boolean);
  assert.deepEqual(deps, ['selection', 'key'],
    're-validation must follow the authorization key as well as the selection');

  // It must still run after the invalidation effect, so the net result is READY and not IDLE.
  assert.ok(views.indexOf("dispatch({ type: 'INVALIDATE' })") < views.indexOf("dispatch({ type: 'VALIDATED' })"),
    'invalidation is declared before re-validation so the order of effects is deterministic');
});

test('a market address arriving after the file leaves the machine startable', () => {
  // The exact Launch sequence, replayed through the reducer: file chosen, then the market
  // confirmed (key change → invalidate → re-validate), then the automatic start.
  let state = mediaUploadReducer(undefined, {});
  state = mediaUploadReducer(state, { type: 'VALIDATED' });          // file picked
  assert.equal(state.status, 'READY');

  state = mediaUploadReducer(state, { type: 'INVALIDATE' });          // market address arrives
  state = mediaUploadReducer(state, { type: 'VALIDATED' });           // selection re-validated
  assert.equal(state.status, 'READY', 'the machine must be startable when auto-attach fires');

  state = mediaUploadReducer(state, { type: 'SIGN' });
  assert.equal(state.status, 'AWAITING_SIGNATURE');
  state = mediaUploadReducer(state, { type: 'UPLOAD' });
  assert.equal(state.status, 'UPLOADING');
  state = mediaUploadReducer(state, { type: 'SUCCESS', result: { contentHash: '0xabc' } });
  assert.equal(state.status, 'UPLOADED', 'the surface can finally report the attach');
});

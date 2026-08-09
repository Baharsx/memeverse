import { detectImageType, IMAGE_SIGNATURE_PROBE_BYTES } from './image-signature.js';
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  normalizeImageMimeType,
} from './media-authorization.js';

/**
 * The client-side model of attaching an image.
 *
 * This is a state machine rather than a handful of booleans because the states are genuinely
 * exclusive and the illegal combinations are the dangerous ones. "Has a signature but the file
 * changed", "uploading and also idle", "uploaded, showing preview B, having committed hash A" —
 * each is representable with independent flags and each is a real bug. Here they simply cannot be
 * constructed.
 *
 * Everything in this module is pure so it can be tested without a browser: no DOM, no fetch, no
 * React. The hook that drives it lives with the views.
 */

export const MEDIA_UPLOAD_STATES = Object.freeze([
  'IDLE', 'VALIDATING', 'READY', 'AWAITING_SIGNATURE', 'UPLOADING', 'UPLOADED', 'FAILED',
]);

export const initialMediaUploadState = Object.freeze({
  status: 'IDLE',
  error: null,
  result: null,
});

/**
 * Which states are mid-flight.
 *
 * A double click must not start a second upload beside the first: both would ask for a signature,
 * both would race to move the market's pointer, and the loser would silently win the preview. The
 * button reads this, and the reducer refuses the transition regardless of what the button does.
 */
export function isMediaUploadBusy(status) {
  return status === 'VALIDATING' || status === 'AWAITING_SIGNATURE' || status === 'UPLOADING';
}

/** Whether an upload may begin from this state. */
export function canStartMediaUpload(status) {
  return status === 'READY' || status === 'FAILED';
}

/**
 * The single legal transition table.
 *
 * `SELECT` and `INVALIDATE` are accepted from every state on purpose: picking a different file or
 * switching wallet must always be able to tear down whatever came before, including a completed
 * upload whose result no longer describes what the user is looking at.
 */
export function mediaUploadReducer(state = initialMediaUploadState, event = {}) {
  switch (event.type) {
    case 'SELECT':
      return { status: 'VALIDATING', error: null, result: null };
    case 'VALIDATED':
      return { status: 'READY', error: null, result: null };
    case 'INVALID':
      return { status: 'FAILED', error: event.error ?? 'That file cannot be used.', result: null };
    case 'SIGN':
      if (!canStartMediaUpload(state.status)) return state;
      return { status: 'AWAITING_SIGNATURE', error: null, result: null };
    case 'UPLOAD':
      if (state.status !== 'AWAITING_SIGNATURE') return state;
      return { status: 'UPLOADING', error: null, result: null };
    case 'SUCCESS':
      if (state.status !== 'UPLOADING') return state;
      return { status: 'UPLOADED', error: null, result: event.result ?? null };
    case 'FAIL':
      return { status: 'FAILED', error: event.error ?? 'The upload failed.', result: null };
    case 'INVALIDATE':
    case 'RESET':
      return initialMediaUploadState;
    default:
      return state;
  }
}

/**
 * Identity of everything an authorization is bound to.
 *
 * A signature covers a specific market, a specific set of bytes, and is only useful to the wallet
 * that produced it. When any of those changes the previous authorization is not merely stale, it
 * is for a different thing — so the views compare this key and reset rather than trying to reason
 * about which parts survived.
 */
export function mediaAuthorizationKey({ market, contentHash, wallet } = {}) {
  return [
    market ?? '',
    contentHash ?? '',
    typeof wallet === 'string' ? wallet.toLowerCase() : '',
  ].join('|');
}

/**
 * What the Launch page should say about artwork once a market exists.
 *
 * A launch and an artwork attachment are two independent outcomes, and this function exists so
 * that fact is expressed in one place rather than re-derived by whichever piece of JSX happens to
 * be rendering. Nothing it returns can turn a confirmed launch into a failure: the worst stage is
 * `FAILED`, which the caller renders beside — never instead of — the launch receipt.
 */
export const LAUNCH_ARTWORK_STAGES = Object.freeze({
  NONE: 'NONE',
  WAITING: 'WAITING',
  SIGNING: 'SIGNING',
  UPLOADING: 'UPLOADING',
  ATTACHED: 'ATTACHED',
  FAILED: 'FAILED',
  WRONG_WALLET: 'WRONG_WALLET',
});

export function launchArtworkStage({
  hasSelection = false,
  launched = false,
  walletMatchesCreator = true,
  status = 'IDLE',
} = {}) {
  // No image chosen, or nothing launched yet: the artwork surface does not exist at all, and a
  // launch without artwork must look exactly as it always has.
  if (!hasSelection || !launched) return LAUNCH_ARTWORK_STAGES.NONE;

  switch (status) {
    case 'AWAITING_SIGNATURE': return LAUNCH_ARTWORK_STAGES.SIGNING;
    case 'UPLOADING': return LAUNCH_ARTWORK_STAGES.UPLOADING;
    case 'UPLOADED': return LAUNCH_ARTWORK_STAGES.ATTACHED;
    case 'FAILED': return LAUNCH_ARTWORK_STAGES.FAILED;
    default:
      // Not yet started. A wallet that is not the market's creator cannot sign a valid
      // authorization, so say that instead of appearing to hang.
      return walletMatchesCreator
        ? LAUNCH_ARTWORK_STAGES.WAITING
        : LAUNCH_ARTWORK_STAGES.WRONG_WALLET;
  }
}

/** Whether the creator should be offered a retry, which reuses the already-selected file. */
export function canRetryLaunchArtwork(stage) {
  return stage === LAUNCH_ARTWORK_STAGES.FAILED || stage === LAUNCH_ARTWORK_STAGES.WRONG_WALLET;
}

export const ACCEPTED_IMAGE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp']);

/** The `accept` attribute for a file input, derived from the same allowlist the server enforces. */
export const IMAGE_ACCEPT_ATTRIBUTE = [
  ...Object.keys(ALLOWED_IMAGE_TYPES),
  ...ACCEPTED_IMAGE_EXTENSIONS,
].join(',');

export function formatImageSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Checks a file's declared type and size before anything is read.
 *
 * Cheap and synchronous, so an obviously wrong pick is refused instantly. It deliberately does not
 * decide anything: `validateImageBytes` still inspects the real content, and the server still
 * decides for real.
 */
export function validateImageFile(file) {
  if (!file) return { ok: false, error: 'Choose an image file.' };
  if (file.size === 0) return { ok: false, error: 'That file is empty.' };
  if (file.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `That image is ${formatImageSize(file.size)}. The limit is 5 MB.`,
    };
  }
  const mimeType = normalizeImageMimeType(file.type);
  if (!mimeType) {
    return { ok: false, error: 'Images must be PNG, JPEG, or WebP.' };
  }
  return { ok: true, mimeType };
}

/**
 * Confirms the bytes really are the format the file claimed.
 *
 * This is the check that catches `logo.svg` renamed to `logo.png`, and it runs before the wallet
 * prompt so the creator is never asked to sign for a file the server is going to reject.
 */
export function validateImageBytes(bytes, declaredMimeType) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return { ok: false, error: 'That file could not be read.' };
  }
  if (bytes.length < IMAGE_SIGNATURE_PROBE_BYTES) {
    return { ok: false, error: 'That file is too small to be a valid image.' };
  }
  const detected = detectImageType(bytes);
  if (!detected) {
    return { ok: false, error: 'That file is not a valid PNG, JPEG, or WebP image.' };
  }
  const claimed = normalizeImageMimeType(declaredMimeType);
  if (claimed && detected !== claimed) {
    return { ok: false, error: 'That file’s contents do not match its type.' };
  }
  return { ok: true, mimeType: detected };
}

/**
 * The message shown when an upload fails.
 *
 * Deliberately maps each server code to plain language. A creator who is told
 * "MEDIA_NOT_CREATOR" learns nothing; one told which wallet the market expects can fix it.
 */
export function mediaUploadErrorMessage(error) {
  switch (error?.code) {
    case 'MEDIA_NOT_CREATOR':
      return 'This market was created by a different wallet. Connect the creator wallet to set its image.';
    case 'MARKET_NOT_REGISTERED':
      return 'That market is not registered in the trusted MemeVerse factory.';
    case 'MEDIA_AUTHORIZATION_EXPIRED':
      return 'The authorization expired before it was used. Try again to sign a fresh one.';
    case 'MEDIA_HASH_MISMATCH':
      return 'The uploaded file did not match what was authorized. Choose the file again.';
    case 'MEDIA_TOO_LARGE':
      return 'That image is larger than the 5 MB limit.';
    case 'MEDIA_TYPE_UNSUPPORTED':
    case 'MEDIA_TYPE_MISMATCH':
    case 'MEDIA_CONTENT_INVALID':
      return 'That file is not a valid PNG, JPEG, or WebP image.';
    case 'MEDIA_NOT_AVAILABLE':
      return 'Image hosting is unavailable right now. The market itself is unaffected.';
    default:
      return error?.message ?? 'The image could not be attached.';
  }
}

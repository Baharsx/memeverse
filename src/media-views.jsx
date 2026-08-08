import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { keccak256 } from 'viem';
import { useAccount, useSignMessage } from 'wagmi';
import { arc } from './arc.js';
import { mediaContentUrl, uploadMedia } from './api.js';
import {
  mediaAuthorizationExpiry,
  mediaAuthorizationMessage,
} from './media-authorization.js';
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
} from './media-upload.js';

/**
 * Shared image surfaces: the mark fallback, the picker, and the creator-signed attach control.
 *
 * These exist as one module because the three of them share a single rule — an image is a nice
 * thing to have and never a thing the page depends on. Every component here renders something
 * correct when there is no image, when the image fails to load, and when the media service is
 * entirely unavailable.
 */

/**
 * A market's artwork, falling back to the MemeVerse mark.
 *
 * The fallback fires at most once. An `onError` handler that swaps in another URL which can also
 * fail is the classic way to build an infinite request loop, so the handler clears the source and
 * latches, and the mark is rendered as an ordinary element rather than as a retry.
 */
export function MarketImage({ src, alt, className = '', size = 'md' }) {
  const [failed, setFailed] = useState(false);
  // A new source deserves one fresh attempt; without this a market that once failed would keep
  // showing the mark even after its creator uploaded a working replacement.
  useEffect(() => { setFailed(false); }, [src]);

  const resolved = failed ? null : src;
  return (
    <span className={`market-image market-image-${size} ${className}`.trim()} aria-hidden={!alt}>
      {resolved
        ? (
          <img
            src={resolved}
            alt={alt ?? ''}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
          />
        )
        : (
          <img
            className="market-image-fallback pixel-mark"
            src={`${import.meta.env.BASE_URL}memeverse-mark.png`}
            alt={alt ? `${alt} (no artwork set)` : ''}
            loading="lazy"
            decoding="async"
          />
        )}
    </span>
  );
}

/**
 * Holds the selected file, its preview URL, its bytes, and its keccak256 digest.
 *
 * The object URL is the part that has to be right. Every replacement revokes its predecessor and
 * unmount revokes the last one, because an un-revoked blob URL pins the whole file in memory for
 * the life of the document — with 5 MB images and a creator trying four of them, that is the
 * difference between a working page and a tab the browser kills.
 *
 * Reads are also generation-guarded: picking B while A is still being read must not let A's bytes
 * arrive late and overwrite B's, which is exactly how a preview and a hash end up describing
 * different files.
 */
export function useImageSelection() {
  const [selection, setSelection] = useState(null);
  const [error, setError] = useState(null);
  const previewRef = useRef(null);
  const generationRef = useRef(0);

  const revokePreview = useCallback(() => {
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    }
  }, []);

  // Unmount is the case a component cannot handle for itself: navigating away from Launch mid-pick
  // would otherwise leak the blob for the rest of the session.
  useEffect(() => revokePreview, [revokePreview]);

  const clear = useCallback(() => {
    generationRef.current += 1;
    revokePreview();
    setSelection(null);
    setError(null);
  }, [revokePreview]);

  const select = useCallback(async (file) => {
    generationRef.current += 1;
    const generation = generationRef.current;
    revokePreview();
    setSelection(null);

    if (!file) {
      setError(null);
      return null;
    }

    const declared = validateImageFile(file);
    if (!declared.ok) {
      setError(declared.error);
      return null;
    }

    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      if (generation === generationRef.current) setError('That file could not be read.');
      return null;
    }
    // A later pick already superseded this read; its result is stale by definition.
    if (generation !== generationRef.current) return null;

    const verified = validateImageBytes(bytes, declared.mimeType);
    if (!verified.ok) {
      setError(verified.error);
      return null;
    }

    const previewUrl = URL.createObjectURL(file);
    previewRef.current = previewUrl;
    const next = {
      bytes,
      mimeType: verified.mimeType,
      byteLength: bytes.length,
      // The commitment is over the exact bytes on disk, which is what the server rehashes and
      // what any third party can recompute from the same file.
      contentHash: keccak256(bytes).toLowerCase(),
      previewUrl,
      sizeLabel: formatImageSize(bytes.length),
    };
    setSelection(next);
    setError(null);
    return next;
  }, [revokePreview]);

  return { selection, error, select, clear };
}

/**
 * Drives one creator-signed upload.
 *
 * The wallet prompt and the network call are separate states so the UI can say which one it is
 * waiting on — "check your wallet" and "uploading" mean very different things to someone whose
 * extension did not open. A single in-flight guard covers both, so a double click cannot produce
 * two signatures or two writes.
 */
export function useMediaUpload({ action, market, selection, onUploaded }) {
  const [state, dispatch] = useReducer(mediaUploadReducer, initialMediaUploadState);
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  // The authorization is bound to a market, a set of bytes, and a wallet. If any of them changes,
  // whatever was signed or uploaded describes something the user is no longer looking at.
  const key = mediaAuthorizationKey({
    market, contentHash: selection?.contentHash, wallet: address,
  });
  const previousKeyRef = useRef(key);
  useEffect(() => {
    if (previousKeyRef.current !== key) {
      previousKeyRef.current = key;
      dispatch({ type: 'INVALIDATE' });
    }
  }, [key]);

  useEffect(() => {
    if (selection) dispatch({ type: 'VALIDATED' });
  }, [selection]);

  const start = useCallback(async () => {
    if (inFlightRef.current || !selection || !market) return;
    if (!canStartMediaUpload(state.status) && state.status !== 'IDLE') return;
    inFlightRef.current = true;

    const expiresAt = mediaAuthorizationExpiry();
    try {
      dispatch({ type: 'SIGN' });
      const message = mediaAuthorizationMessage({
        action,
        chainId: arc.id,
        market,
        contentHash: selection.contentHash,
        expiresAt,
      });
      const signature = await signMessageAsync({ message });

      dispatch({ type: 'UPLOAD' });
      const result = await uploadMedia({
        bytes: selection.bytes,
        mimeType: selection.mimeType,
        action,
        market,
        contentHash: selection.contentHash,
        expiresAt,
        signature,
      });

      // The server hashes what it received. If its answer disagrees with what was signed, the
      // bytes in flight were not the bytes on disk, and nothing about this upload is trustworthy.
      if (result.contentHash !== selection.contentHash) {
        throw new Error('The server verified a different file. Nothing was attached.');
      }
      if (!mountedRef.current) return;
      dispatch({ type: 'SUCCESS', result });
      await onUploaded?.(result);
    } catch (error) {
      if (!mountedRef.current) return;
      const rejected = error?.name === 'UserRejectedRequestError'
        || /user rejected|denied|rejected the request/i.test(error?.message ?? '');
      dispatch({
        type: 'FAIL',
        error: rejected
          ? 'Signature declined. Nothing was attached.'
          : mediaUploadErrorMessage(error),
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [action, market, selection, signMessageAsync, state.status, onUploaded]);

  return { state, start, reset: () => dispatch({ type: 'RESET' }) };
}

/** Human-readable label for each state of the machine. */
const UPLOAD_LABELS = Object.freeze({
  AWAITING_SIGNATURE: 'CHECK YOUR WALLET — SIGNING IS FREE',
  UPLOADING: 'UPLOADING IMAGE…',
  UPLOADED: 'IMAGE ATTACHED',
});

/** Status line for an in-progress or finished attach. */
export function MediaUploadStatus({ state }) {
  if (!state || state.status === 'IDLE' || state.status === 'READY') return null;
  if (state.status === 'FAILED') {
    return <small className="tx-error media-status" role="alert">{state.error}</small>;
  }
  const label = UPLOAD_LABELS[state.status];
  if (!label) return null;
  return (
    <small className={`media-status ${state.status === 'UPLOADED' ? 'ok' : ''}`} role="status" aria-live="polite">
      {label}
    </small>
  );
}

/**
 * File input plus preview.
 *
 * The preview is the whole point of picking before committing, so it renders the local blob
 * immediately — no round trip, no wallet prompt, nothing signed. Choosing is free and reversible
 * right up until the creator clicks attach.
 */
export function ImagePicker({
  id,
  label = 'MARKET IMAGE',
  hint = 'PNG, JPEG, or WebP. Up to 5 MB. Optional.',
  selection,
  error,
  onSelect,
  onClear,
  disabled = false,
}) {
  const inputRef = useRef(null);

  function handleChange(event) {
    const [file] = event.target.files ?? [];
    onSelect(file ?? null);
  }

  function handleClear() {
    // The input keeps its own value, and a stale one means re-picking the same file fires no
    // change event at all — the control would silently stop working.
    if (inputRef.current) inputRef.current.value = '';
    onClear();
  }

  return (
    <div className="image-picker">
      <label htmlFor={id}>
        {label}
        <input
          id={id}
          ref={inputRef}
          type="file"
          accept={IMAGE_ACCEPT_ATTRIBUTE}
          onChange={handleChange}
          disabled={disabled}
        />
        <small>{hint}</small>
      </label>
      {error ? <small className="tx-error" role="alert">{error}</small> : null}
      {selection ? (
        <div className="image-preview">
          <img src={selection.previewUrl} alt="Selected market artwork preview" />
          <div className="image-preview-facts">
            <span>{selection.mimeType.replace('image/', '').toUpperCase()} // {selection.sizeLabel}</span>
            <code title={selection.contentHash}>
              {selection.contentHash.slice(0, 10)}…{selection.contentHash.slice(-8)}
            </code>
            <button type="button" className="btn ghost small" onClick={handleClear} disabled={disabled}>
              REMOVE
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The creator-only control that attaches a chosen image to a market.
 *
 * Rendered only where the connected wallet matches the market's onchain `creator()`. That check is
 * presentation, not protection: the server independently reads `creator()` from Arc and refuses
 * anything else, so hiding this button and enforcing the rule are two separate mechanisms and only
 * the second one matters.
 */
export function AttachImageButton({ state, onStart, disabled = false, children }) {
  const busy = isMediaUploadBusy(state.status);
  return (
    <>
      <button
        type="button"
        className="btn secondary full"
        disabled={disabled || busy || state.status === 'UPLOADED'}
        onClick={onStart}
      >
        {state.status === 'UPLOADED' ? 'IMAGE ATTACHED ✓' : children}
      </button>
      <MediaUploadStatus state={state} />
    </>
  );
}

export { mediaContentUrl };

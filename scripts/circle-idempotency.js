import { createHash } from 'node:crypto';

/**
 * Produces a Circle-compatible UUID whose identity is bound to the exact operation payload.
 * The version/variant bits use UUID v4 format because Circle requires it. Deterministic input
 * preserves safe retries, while any bytecode, address, or parameter change produces a new key.
 */
export function circleIdempotencyKey(scope, parts) {
  const digest = createHash('sha256')
    .update(JSON.stringify([scope, ...parts]))
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

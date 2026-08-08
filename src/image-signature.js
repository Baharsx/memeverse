/**
 * Format detection from the leading bytes of a file.
 *
 * Shared by the browser and the server for the same reason the authorization message is shared:
 * if the picker accepted a file the API would later refuse, a creator would sign a wallet prompt
 * and only then be told the file was never valid. One implementation means the preview and the
 * upload agree about what an image is.
 *
 * The server is still the security boundary. This runs in the browser purely so the rejection
 * happens before a signature is requested — a client-side check is a courtesy, never a control.
 *
 * Works on plain `Uint8Array`, so Node's `Buffer` (which is one) passes through unchanged.
 */

function matches(bytes, offset, ascii) {
  for (let index = 0; index < ascii.length; index += 1) {
    if (bytes[offset + index] !== ascii.charCodeAt(index)) return false;
  }
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The number of leading bytes any detection below needs. */
export const IMAGE_SIGNATURE_PROBE_BYTES = 16;

/**
 * Returns the MIME type the bytes actually are, or null.
 *
 * Null is the answer for every file this system will not host — SVG, GIF, HTML, a renamed
 * executable, a truncated download — and the callers treat it as a refusal rather than a hint.
 */
export function detectImageType(input) {
  const bytes = input instanceof Uint8Array ? input : null;
  if (!bytes || bytes.length < 12) return null;

  // PNG: the 8-byte signature, then the IHDR chunk that every real PNG opens with. Requiring
  // IHDR rejects a file that carries only the magic number as a disguise.
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    if (bytes.length >= 16 && matches(bytes, 12, 'IHDR')) return 'image/png';
    return null;
  }

  // JPEG: the SOI marker, and — because a truncated upload is otherwise indistinguishable from a
  // complete one — the EOI marker that closes a whole file.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    if (bytes.length < 4) return null;
    if (bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return 'image/jpeg';
    return null;
  }

  // WebP: 'RIFF' <u32 little-endian size> 'WEBP', then a VP8/VP8L/VP8X chunk.
  if (matches(bytes, 0, 'RIFF') && matches(bytes, 8, 'WEBP')) {
    if (bytes.length < 16) return null;
    // The declared size covers everything after the size field. It must not claim more data than
    // arrived — that is the truncation case — and RIFF pads chunks to an even length, so a single
    // trailing byte of slack is legitimate rather than a mismatch.
    const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    if (declared + 8 > bytes.length || declared + 8 < bytes.length - 1) return null;
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk !== 'VP8 ' && chunk !== 'VP8L' && chunk !== 'VP8X') return null;
    return 'image/webp';
  }

  return null;
}

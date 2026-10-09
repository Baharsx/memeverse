const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, { code = 'API_ERROR', status = 0, requestId, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(8000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.error?.message ?? `API request failed with HTTP ${response.status}.`, {
      code: payload?.error?.code,
      status: response.status,
      requestId: payload?.requestId ?? response.headers.get('x-request-id'),
      details: payload?.error?.details,
    });
  }
  return payload;
}

export async function getApiHealth() {
  try {
    return await request('/api/health');
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) {
      return { status: 'degraded', arc: { status: 'degraded' } };
    }
    throw error;
  }
}

/**
 * Uploads image bytes under a creator's wallet authorization.
 *
 * The body is the file itself. The server hashes the bytes it actually receives.
 */
export async function uploadMedia({
  bytes, mimeType, action, market, contentHash, expiresAt, signature, signal,
}) {
  const response = await fetch(`${API_BASE_URL}/api/v1/media/uploads`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': mimeType,
      'x-memeverse-action': action,
      'x-memeverse-market': market,
      'x-memeverse-content-hash': contentHash,
      'x-memeverse-expires-at': expiresAt,
      'x-memeverse-signature': signature,
    },
    body: bytes,
    signal: signal ?? AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.error?.message ?? `Upload failed with HTTP ${response.status}.`, {
      code: payload?.error?.code,
      status: response.status,
      requestId: payload?.requestId ?? response.headers.get('x-request-id'),
      details: payload?.error?.details,
    });
  }
  return payload.data;
}

/**
 * Resolves artwork for a list of markets in one request.
 *
 * Markets without an image are absent. A media outage resolves to an empty map so prices still render.
 */
export async function getMarketImages(markets) {
  const addresses = [...new Set((markets ?? []).filter(Boolean))];
  if (addresses.length === 0) return {};
  const images = {};
  for (let index = 0; index < addresses.length; index += 100) {
    const page = addresses.slice(index, index + 100);
    try {
      const payload = await request(
        `/api/v1/media/markets?markets=${encodeURIComponent(page.join(','))}`,
      );
      Object.assign(images, payload?.data ?? {});
    } catch {
      // Artwork is decoration. A failed page leaves those markets without an image.
    }
  }
  return images;
}

/** Absolute, same-origin URL for a stored image. */
export function mediaContentUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/v1/media/content/')) return null;
  return `${API_BASE_URL}${path}`;
}

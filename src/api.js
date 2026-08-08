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
    // The operator session is an HttpOnly, SameSite=Strict cookie. It is never readable from
    // JavaScript and is only ever sent to the same origin as the application.
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

export async function createSettlementQuote(input, idempotencyKey) {
  return request('/api/v1/settlements/quote', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify(input),
  });
}

export async function createAgentDecision(input, idempotencyKey) {
  return request('/api/v1/agent/decisions', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify(input),
  });
}

export async function getAppKitCapabilities() {
  return request('/api/v1/app-kit/capabilities');
}

export async function estimateAppKitSwap(input) {
  return request('/api/v1/app-kit/swap/estimate', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function prepareSettlement(settlementId) {
  return request(`/api/v1/settlements/${encodeURIComponent(settlementId)}/prepare`, {
    method: 'POST',
  });
}

export async function requestOperatorChallenge(address) {
  return request('/api/v1/auth/challenge', {
    method: 'POST',
    body: JSON.stringify({ address }),
  });
}

export async function verifyOperatorSignature(challengeId, signature) {
  return request('/api/v1/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, signature }),
  });
}

export async function getOperatorSession() {
  return request('/api/v1/auth/session');
}

export async function endOperatorSession() {
  return request('/api/v1/auth/logout', { method: 'POST' });
}

export async function authorizeSettlementExecution(settlementId) {
  return request(
    `/api/v1/settlements/${encodeURIComponent(settlementId)}/execution-authorization`,
    { method: 'POST' },
  );
}

export async function executeSettlement(settlementId, authorizationId) {
  return request(`/api/v1/settlements/${encodeURIComponent(settlementId)}/execute`, {
    method: 'POST',
    body: JSON.stringify({ authorizationId }),
  });
}

export async function reconcileSettlement(settlementId) {
  return request(`/api/v1/settlements/${encodeURIComponent(settlementId)}/reconcile`, {
    method: 'POST',
  });
}

export async function getCircleWallet() {
  return request('/api/v1/circle/wallet');
}

/**
 * Sanitized public view of the autonomous agent.
 *
 * Readable without an operator session: it carries policy versions, caps, and decision outcomes,
 * but no Circle wallet identifiers or credentials.
 */
export async function getAgentAutonomy() {
  const payload = await request('/api/v1/agent/autonomy');
  return payload.data;
}

/** Operator-only emergency stop. Never required for an eligible payout to execute. */
export async function setAgentAutonomyPaused(paused, reason) {
  const payload = await request('/api/v1/agent/autonomy', {
    method: 'POST',
    body: JSON.stringify(reason ? { paused, reason } : { paused }),
  });
  return payload.data;
}

/**
 * Uploads image bytes under a creator's wallet authorization.
 *
 * The body is the file itself, unmodified: no base64, no multipart, no filename. Everything the
 * server needs to check the authorization rides in headers, and the server hashes the bytes it
 * actually receives — so this helper cannot misrepresent what is being attached even if it wanted
 * to. The timeout is long relative to other calls because a 5 MB body on a phone connection is a
 * legitimately slow request, not a hung one.
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
 * Markets without an image are simply absent from the result, and a failure resolves to an empty
 * map rather than throwing: artwork is decoration over live financial data, and a media outage
 * must never stop a market list from rendering its prices.
 */
export async function getMarketImages(markets) {
  const addresses = [...new Set((markets ?? []).filter(Boolean))].slice(0, 100);
  if (addresses.length === 0) return {};
  try {
    const payload = await request(
      `/api/v1/media/markets?markets=${encodeURIComponent(addresses.join(','))}`,
    );
    return payload?.data ?? {};
  } catch {
    return {};
  }
}

/** Absolute, same-origin URL for a stored image. */
export function mediaContentUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/v1/media/content/')) return null;
  return `${API_BASE_URL}${path}`;
}

export function createIdempotencyKey() {
  return `memeverse-${crypto.randomUUID()}`;
}

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

export function createIdempotencyKey() {
  return `memeverse-${crypto.randomUUID()}`;
}

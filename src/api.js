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

export async function prepareSettlement(settlementId) {
  return request(`/api/v1/settlements/${encodeURIComponent(settlementId)}/prepare`, {
    method: 'POST',
  });
}

export async function executeSettlement(settlementId) {
  return request(`/api/v1/settlements/${encodeURIComponent(settlementId)}/execute`, {
    method: 'POST',
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

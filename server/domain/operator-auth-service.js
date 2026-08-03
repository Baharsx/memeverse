import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getAddress, isAddress, keccak256, recoverMessageAddress, stringToHex } from 'viem';
import { DomainError } from './errors.js';

export const OPERATOR_SESSION_SCOPE = 'SETTLEMENT_OPERATOR_SESSION';
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{128,130}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Non-operator wallets, bad signatures, and unknown challenges are indistinguishable. */
function authenticationFailed() {
  return new DomainError('OPERATOR_AUTH_FAILED', 'Operator authentication failed.', { status: 401 });
}

/**
 * The exact execution parameters an operator approves. Any later change to the recipient,
 * payout, chain, Memo ID, settlement contract, or encoded call invalidates the approval.
 */
export function settlementExecutionBinding(record) {
  return {
    settlementId: record.id,
    chainId: record.chainId,
    recipient: record.recipient,
    creatorPayoutUnits: record.amount?.creatorPayoutUnits ?? null,
    memoId: record.memoId,
    settlementContract: record.executionPlan?.targetContract ?? null,
    memoContract: record.executionPlan?.memoContract ?? null,
    callDataHash: record.executionPlan?.callDataHash ?? null,
  };
}

export function settlementExecutionBindingHash(record) {
  return keccak256(stringToHex(JSON.stringify(settlementExecutionBinding(record))));
}

export function buildOperatorChallengeMessage({
  domain, address, origin, chainId, scope, challengeId, nonce, issuedAt, expiresAt,
}) {
  return [
    `${domain} wants you to sign in with your Arc wallet:`,
    address,
    '',
    'Authorize MemeVerse settlement operator session.',
    'Signing does not move funds and does not approve any transaction.',
    '',
    `URI: ${origin}`,
    `Chain ID: ${chainId}`,
    `Scope: ${scope}`,
    `Challenge ID: ${challengeId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
  ].join('\n');
}

export class OperatorAuthService {
  constructor({
    store,
    operatorAddress,
    appOrigin,
    chainId,
    challengeTtlSeconds,
    sessionTtlSeconds,
    executionTtlSeconds,
    now = () => new Date(),
    randomToken = () => randomBytes(32).toString('base64url'),
    id = randomUUID,
  }) {
    this.store = store;
    this.operatorAddress = operatorAddress ? getAddress(operatorAddress) : undefined;
    this.appOrigin = appOrigin;
    this.chainId = chainId;
    this.challengeTtlSeconds = challengeTtlSeconds;
    this.sessionTtlSeconds = sessionTtlSeconds;
    this.executionTtlSeconds = executionTtlSeconds;
    this.now = now;
    this.randomToken = randomToken;
    this.id = id;
  }

  get configured() {
    return Boolean(this.operatorAddress && this.store);
  }

  configuration() {
    return {
      configured: this.configured,
      scope: OPERATOR_SESSION_SCOPE,
      chainId: this.chainId,
      challengeTtlSeconds: this.challengeTtlSeconds,
      sessionTtlSeconds: this.sessionTtlSeconds,
      executionAuthorizationTtlSeconds: this.executionTtlSeconds,
    };
  }

  requireConfigured() {
    if (!this.configured) {
      throw new DomainError(
        'OPERATOR_AUTH_NOT_CONFIGURED',
        'Operator authentication is unavailable until SETTLEMENT_OPERATOR_ADDRESS is configured.',
        { status: 503 },
      );
    }
  }

  expiry(seconds, from = this.now()) {
    return new Date(from.getTime() + seconds * 1000).toISOString();
  }

  async createChallenge(address) {
    this.requireConfigured();
    if (typeof address !== 'string' || !isAddress(address)) {
      throw new DomainError('INVALID_OPERATOR_ADDRESS', 'A valid EVM address is required.', {
        details: { field: 'address' },
      });
    }
    const issuedAtDate = this.now();
    const issuedAt = issuedAtDate.toISOString();
    const expiresAt = this.expiry(this.challengeTtlSeconds, issuedAtDate);
    const challengeId = this.id();
    const nonce = this.randomToken();
    // A challenge is issued for any well-formed address so that an unauthenticated caller
    // cannot enumerate the configured operator wallet from this endpoint.
    const message = buildOperatorChallengeMessage({
      domain: new URL(this.appOrigin).host,
      address: getAddress(address),
      origin: this.appOrigin,
      chainId: this.chainId,
      scope: OPERATOR_SESSION_SCOPE,
      challengeId,
      nonce,
      issuedAt,
      expiresAt,
    });
    await this.store.createChallenge({
      id: challengeId,
      nonceHash: sha256Hex(nonce),
      message,
      address: getAddress(address),
      origin: this.appOrigin,
      chainId: this.chainId,
      issuedAt,
      expiresAt,
    });
    return { challengeId, message, expiresAt };
  }

  async verify({ challengeId, signature }) {
    this.requireConfigured();
    if (typeof challengeId !== 'string' || challengeId.length < 8 || challengeId.length > 128
      || typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) {
      throw authenticationFailed();
    }
    const nowIso = this.now().toISOString();
    // Consumed before verification so a failed or replayed attempt can never reuse the nonce.
    const challenge = await this.store.consumeChallenge(challengeId, nowIso);
    if (!challenge) throw authenticationFailed();
    if (challenge.origin !== this.appOrigin || challenge.chainId !== this.chainId) {
      throw authenticationFailed();
    }

    let recovered;
    try {
      recovered = getAddress(await recoverMessageAddress({
        message: challenge.message,
        signature,
      }));
    } catch {
      throw authenticationFailed();
    }
    if (recovered !== challenge.address || recovered !== this.operatorAddress) {
      throw authenticationFailed();
    }

    const token = this.randomToken();
    const session = {
      id: this.id(),
      tokenHash: sha256Hex(token),
      address: this.operatorAddress,
      challengeId: challenge.id,
      createdAt: nowIso,
      expiresAt: this.expiry(this.sessionTtlSeconds),
    };
    await this.store.createSession(session);
    return {
      token,
      session: { id: session.id, address: session.address, expiresAt: session.expiresAt },
    };
  }

  async authenticate(token) {
    if (!this.configured || typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return undefined;
    const session = await this.store.getActiveSession(sha256Hex(token), this.now().toISOString());
    if (!session) return undefined;
    // A rotated SETTLEMENT_OPERATOR_ADDRESS immediately invalidates older operator sessions.
    if (getAddress(session.address) !== this.operatorAddress) {
      throw new DomainError('OPERATOR_FORBIDDEN', 'This session is no longer an authorized operator.', {
        status: 403,
      });
    }
    return session;
  }

  async logout(token) {
    if (!this.configured || typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
    return this.store.revokeSession(sha256Hex(token), this.now().toISOString());
  }

  async createExecutionAuthorization({ session, settlement }) {
    this.requireConfigured();
    const authorizationId = this.randomToken();
    const binding = settlementExecutionBinding(settlement);
    const authorization = {
      idHash: sha256Hex(authorizationId),
      sessionId: session.id,
      settlementId: settlement.id,
      bindingHash: settlementExecutionBindingHash(settlement),
      operatorAddress: this.operatorAddress,
      createdAt: this.now().toISOString(),
      expiresAt: this.expiry(this.executionTtlSeconds),
    };
    await this.store.createExecutionAuthorization(authorization);
    return { authorizationId, expiresAt: authorization.expiresAt, binding };
  }

  /**
   * Consumes a one-time authorization and returns the persisted execution authority. The
   * authorization is burned even when a later check rejects it, so nothing can be replayed.
   */
  async consumeExecutionAuthorization({ authorizationId, session, settlement }) {
    this.requireConfigured();
    if (typeof authorizationId !== 'string' || !TOKEN_PATTERN.test(authorizationId)) {
      throw new DomainError(
        'EXECUTION_AUTHORIZATION_REQUIRED',
        'A current execution authorization is required for this settlement.',
        { status: 403 },
      );
    }
    const nowIso = this.now().toISOString();
    const authorization = await this.store.consumeExecutionAuthorization(
      sha256Hex(authorizationId),
      nowIso,
    );
    if (!authorization) {
      throw new DomainError(
        'EXECUTION_AUTHORIZATION_INVALID',
        'The execution authorization is unknown, already used, or expired.',
        { status: 403 },
      );
    }
    if (authorization.settlementId !== settlement.id || authorization.sessionId !== session.id) {
      throw new DomainError(
        'EXECUTION_AUTHORIZATION_MISMATCH',
        'The execution authorization does not belong to this settlement and operator session.',
        { status: 403 },
      );
    }
    if (authorization.bindingHash !== settlementExecutionBindingHash(settlement)) {
      throw new DomainError(
        'EXECUTION_AUTHORIZATION_STALE',
        'The settlement changed after it was authorized. Review and authorize it again.',
        { status: 409 },
      );
    }
    return {
      mode: 'MANUAL_OPERATOR',
      operatorAddress: getAddress(authorization.operatorAddress),
      sessionId: session.id,
      authorizationRef: sha256Hex(authorizationId).slice(0, 32),
      bindingHash: authorization.bindingHash,
      authorizedAt: nowIso,
    };
  }
}

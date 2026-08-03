/**
 * Durable, multi-process safe storage for operator sign-in challenges, sessions, and
 * per-settlement execution authorizations.
 *
 * Every single-use credential is consumed with a conditional UPDATE so two concurrent API
 * processes cannot both win the same challenge, session, or execution authorization. Only
 * hashes of bearer values are persisted; raw nonces and tokens never reach the database.
 */

function challengeFromRow(row) {
  return row && {
    id: row.id,
    nonceHash: row.nonce_hash,
    message: row.message,
    address: row.address,
    origin: row.origin,
    chainId: Number(row.chain_id),
    issuedAt: new Date(row.issued_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function sessionFromRow(row) {
  return row && {
    id: row.id,
    address: row.address,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function authorizationFromRow(row) {
  return row && {
    sessionId: row.session_id,
    settlementId: row.settlement_id,
    bindingHash: row.binding_hash,
    operatorAddress: row.operator_address,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

export class PostgresOperatorAuthStore {
  constructor({ database }) {
    this.database = database;
  }

  async createChallenge(challenge) {
    await this.database.query(
      `INSERT INTO operator_auth_challenges (
         id, nonce_hash, message, address, origin, chain_id, issued_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)`,
      [
        challenge.id, challenge.nonceHash, challenge.message, challenge.address,
        challenge.origin, challenge.chainId, challenge.issuedAt, challenge.expiresAt,
      ],
    );
    return challenge;
  }

  async consumeChallenge(id, nowIso) {
    const result = await this.database.query(
      `UPDATE operator_auth_challenges
       SET consumed_at = $2::timestamptz
       WHERE id = $1 AND consumed_at IS NULL AND expires_at > $2::timestamptz
       RETURNING *`,
      [id, nowIso],
    );
    return challengeFromRow(result.rows[0]);
  }

  async createSession(session) {
    await this.database.query(
      `INSERT INTO operator_sessions (
         id, token_hash, address, challenge_id, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
      [
        session.id, session.tokenHash, session.address, session.challengeId,
        session.createdAt, session.expiresAt,
      ],
    );
    return session;
  }

  async getActiveSession(tokenHash, nowIso) {
    const result = await this.database.query(
      `SELECT * FROM operator_sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2::timestamptz`,
      [tokenHash, nowIso],
    );
    return sessionFromRow(result.rows[0]);
  }

  async revokeSession(tokenHash, nowIso) {
    const result = await this.database.query(
      `UPDATE operator_sessions SET revoked_at = $2::timestamptz
       WHERE token_hash = $1 AND revoked_at IS NULL
       RETURNING id`,
      [tokenHash, nowIso],
    );
    return result.rows.length > 0;
  }

  async createExecutionAuthorization(authorization) {
    await this.database.query(
      `INSERT INTO operator_execution_authorizations (
         id_hash, session_id, settlement_id, binding_hash, operator_address, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
      [
        authorization.idHash, authorization.sessionId, authorization.settlementId,
        authorization.bindingHash, authorization.operatorAddress,
        authorization.createdAt, authorization.expiresAt,
      ],
    );
    return authorization;
  }

  async consumeExecutionAuthorization(idHash, nowIso) {
    const result = await this.database.query(
      `UPDATE operator_execution_authorizations
       SET consumed_at = $2::timestamptz
       WHERE id_hash = $1 AND consumed_at IS NULL AND expires_at > $2::timestamptz
       RETURNING *`,
      [idHash, nowIso],
    );
    return authorizationFromRow(result.rows[0]);
  }

  async purgeExpired(nowIso) {
    await this.database.query(
      `DELETE FROM operator_auth_challenges WHERE expires_at < $1::timestamptz - interval '1 day'`,
      [nowIso],
    );
    await this.database.query(
      `DELETE FROM operator_sessions WHERE expires_at < $1::timestamptz - interval '1 day'`,
      [nowIso],
    );
    await this.database.query(
      `DELETE FROM operator_execution_authorizations
       WHERE expires_at < $1::timestamptz - interval '1 day'`,
      [nowIso],
    );
  }
}

/** Single-process store used by the automated security tests. */
export class MemoryOperatorAuthStore {
  constructor() {
    this.challenges = new Map();
    this.sessions = new Map();
    this.authorizations = new Map();
  }

  async createChallenge(challenge) {
    this.challenges.set(challenge.id, { ...challenge, consumedAt: null });
    return challenge;
  }

  async consumeChallenge(id, nowIso) {
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.consumedAt) return undefined;
    if (new Date(challenge.expiresAt).getTime() <= new Date(nowIso).getTime()) return undefined;
    challenge.consumedAt = nowIso;
    const { consumedAt, ...rest } = challenge;
    return { ...rest };
  }

  async createSession(session) {
    this.sessions.set(session.tokenHash, { ...session, revokedAt: null });
    return session;
  }

  async getActiveSession(tokenHash, nowIso) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt) return undefined;
    if (new Date(session.expiresAt).getTime() <= new Date(nowIso).getTime()) return undefined;
    return { id: session.id, address: session.address, createdAt: session.createdAt, expiresAt: session.expiresAt };
  }

  async revokeSession(tokenHash, nowIso) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt) return false;
    session.revokedAt = nowIso;
    return true;
  }

  async createExecutionAuthorization(authorization) {
    this.authorizations.set(authorization.idHash, { ...authorization, consumedAt: null });
    return authorization;
  }

  async consumeExecutionAuthorization(idHash, nowIso) {
    const authorization = this.authorizations.get(idHash);
    if (!authorization || authorization.consumedAt) return undefined;
    if (new Date(authorization.expiresAt).getTime() <= new Date(nowIso).getTime()) return undefined;
    authorization.consumedAt = nowIso;
    const { consumedAt, idHash: _idHash, ...rest } = authorization;
    return { ...rest };
  }

  async purgeExpired() {}
}

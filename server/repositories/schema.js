/**
 * Single source of truth for the MemeVerse PostgreSQL schema.
 *
 * `npm run db:migrate` (and local PGlite bootstrap) applies `schemaSql`; a runtime start with
 * migrations disabled asserts against `requiredColumns` instead, so the production one-shot
 * migration identity remains the only DDL-capable identity.
 *
 * Every column the running code reads or writes is listed here. Verifying tables alone let a
 * database carrying an older `settlements` layout start cleanly and then fail on its first
 * write — after a settlement was already in flight. Adding a column to `schemaSql` without
 * adding it here would reopen exactly that gap.
 */
export const requiredColumns = Object.freeze({
  settlements: Object.freeze([
    'id',
    'idempotency_key',
    'circle_transaction_id',
    'state',
    'version',
    'reservation_units',
    'reservation_status',
    'record',
    'created_at',
    'updated_at',
    'reconciliation_lease_owner',
    'reconciliation_lease_until',
    'execution_claim_id',
    'execution_claim_until',
  ]),
  circle_notifications: Object.freeze(['notification_id', 'processed_at', 'outcome']),
  operator_auth_challenges: Object.freeze([
    'id', 'nonce_hash', 'message', 'address', 'origin', 'chain_id',
    'issued_at', 'expires_at', 'consumed_at',
  ]),
  operator_sessions: Object.freeze([
    'id', 'token_hash', 'address', 'challenge_id', 'created_at', 'expires_at', 'revoked_at',
  ]),
  operator_execution_authorizations: Object.freeze([
    'id_hash', 'session_id', 'settlement_id', 'binding_hash', 'operator_address',
    'created_at', 'expires_at', 'consumed_at',
  ]),
});

export const requiredTables = Object.freeze(Object.keys(requiredColumns));

export const schemaSql = `
  CREATE TABLE IF NOT EXISTS settlements (
    id text PRIMARY KEY,
    idempotency_key text NOT NULL UNIQUE,
    circle_transaction_id text UNIQUE,
    state text NOT NULL,
    version bigint NOT NULL DEFAULT 0,
    reservation_units numeric(78, 0) NOT NULL DEFAULT 0,
    reservation_status text NOT NULL DEFAULT 'NONE',
    record jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    reconciliation_lease_owner text,
    reconciliation_lease_until timestamptz,
    execution_claim_id text,
    execution_claim_until timestamptz
  );
  ALTER TABLE settlements
    ADD COLUMN IF NOT EXISTS reconciliation_lease_owner text,
    ADD COLUMN IF NOT EXISTS reconciliation_lease_until timestamptz,
    ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS execution_claim_id text,
    ADD COLUMN IF NOT EXISTS execution_claim_until timestamptz;
  CREATE TABLE IF NOT EXISTS circle_notifications (
    notification_id text PRIMARY KEY,
    processed_at timestamptz NOT NULL,
    outcome jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operator_auth_challenges (
    id text PRIMARY KEY,
    nonce_hash text NOT NULL UNIQUE,
    message text NOT NULL,
    address text NOT NULL,
    origin text NOT NULL,
    chain_id bigint NOT NULL,
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS operator_sessions (
    id text PRIMARY KEY,
    token_hash text NOT NULL UNIQUE,
    address text NOT NULL,
    challenge_id text NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS operator_execution_authorizations (
    id_hash text PRIMARY KEY,
    session_id text NOT NULL,
    settlement_id text NOT NULL,
    binding_hash text NOT NULL,
    operator_address text NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS settlements_state_idx ON settlements (state);
  CREATE INDEX IF NOT EXISTS settlements_created_at_idx ON settlements (created_at DESC);
  CREATE INDEX IF NOT EXISTS settlements_reconciliation_idx
    ON settlements (state, circle_transaction_id)
    WHERE circle_transaction_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS operator_auth_challenges_expiry_idx
    ON operator_auth_challenges (expires_at);
  CREATE INDEX IF NOT EXISTS operator_sessions_expiry_idx ON operator_sessions (expires_at);
  CREATE INDEX IF NOT EXISTS operator_execution_authorizations_settlement_idx
    ON operator_execution_authorizations (settlement_id);
  CREATE INDEX IF NOT EXISTS settlements_execution_claim_idx
    ON settlements (execution_claim_until)
    WHERE execution_claim_id IS NOT NULL;
`;

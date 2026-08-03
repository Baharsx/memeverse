/**
 * Single source of truth for the MemeVerse PostgreSQL schema.
 *
 * `npm run db:migrate` (and local PGlite bootstrap) applies `schemaSql`; a runtime start with
 * migrations disabled only asserts that every table in `requiredTables` already exists, so the
 * production one-shot migration identity remains the only DDL-capable identity.
 */
export const requiredTables = Object.freeze([
  'settlements',
  'circle_notifications',
  'operator_auth_challenges',
  'operator_sessions',
  'operator_execution_authorizations',
]);

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
    reconciliation_lease_until timestamptz
  );
  ALTER TABLE settlements
    ADD COLUMN IF NOT EXISTS reconciliation_lease_owner text,
    ADD COLUMN IF NOT EXISTS reconciliation_lease_until timestamptz,
    ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
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
`;

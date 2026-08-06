import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PostgresSettlementStore } from '../repositories/postgres-settlement-store.js';
import { requiredColumns, requiredTables, schemaSql } from '../repositories/schema.js';

/** The `settlements` table exactly as it stood before optimistic concurrency and claims. */
const legacySettlementsSql = `
  CREATE TABLE settlements (
    id text PRIMARY KEY,
    idempotency_key text NOT NULL UNIQUE,
    circle_transaction_id text UNIQUE,
    state text NOT NULL,
    reservation_units numeric(78, 0) NOT NULL DEFAULT 0,
    reservation_status text NOT NULL DEFAULT 'NONE',
    record jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  );
  CREATE TABLE circle_notifications (
    notification_id text PRIMARY KEY,
    processed_at timestamptz NOT NULL,
    outcome jsonb NOT NULL
  );
  CREATE TABLE operator_auth_challenges (
    id text PRIMARY KEY, nonce_hash text NOT NULL UNIQUE, message text NOT NULL,
    address text NOT NULL, origin text NOT NULL, chain_id bigint NOT NULL,
    issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
  );
  CREATE TABLE operator_sessions (
    id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, address text NOT NULL,
    challenge_id text NOT NULL, created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL, revoked_at timestamptz
  );
  CREATE TABLE operator_execution_authorizations (
    id_hash text PRIMARY KEY, session_id text NOT NULL, settlement_id text NOT NULL,
    binding_hash text NOT NULL, operator_address text NOT NULL,
    created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
  );
`;

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-schema-'));
  const database = new PGlite(directory);
  try {
    return await run(database);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Records every statement so a readiness check can be proven to run no DDL at all. */
function auditedDatabase(database) {
  const statements = [];
  return {
    statements,
    supportsAdvisoryLocks: database.supportsAdvisoryLocks ?? false,
    query(text, params) {
      statements.push(text);
      return database.query(text, params);
    },
    exec(text) {
      statements.push(text);
      return database.exec(text);
    },
    transaction(operation) {
      return database.transaction(operation);
    },
  };
}

const ddlPattern = /\b(CREATE|ALTER|DROP|TRUNCATE)\b/i;

test('a database carrying the pre-claim settlements layout refuses to start', async () => {
  await withDatabase(async (database) => {
    await database.exec(legacySettlementsSql);
    const audited = auditedDatabase(database);
    const store = new PostgresSettlementStore({ database: audited });

    await assert.rejects(
      store.initialize({ migrate: false }),
      (error) => {
        assert.match(error.message, /Database schema is outdated\. Run npm run db:migrate\./);
        // The operator is told exactly which columns are absent, not merely that something is.
        assert.match(error.message, /settlements\.version/);
        assert.match(error.message, /settlements\.execution_claim_id/);
        assert.match(error.message, /settlements\.execution_claim_until/);
        assert.match(error.message, /settlements\.reconciliation_lease_owner/);
        assert.match(error.message, /settlements\.reconciliation_lease_until/);
        return true;
      },
    );

    assert.equal(
      audited.statements.some((statement) => ddlPattern.test(statement)),
      false,
      'a readiness check must never mutate schema',
    );
    const columns = await database.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'settlements'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    assert.equal(names.includes('version'), false, 'the stale table is left exactly as it was');
    assert.equal(names.includes('execution_claim_id'), false);
  });
});

test('a database missing a required table names the table rather than its columns', async () => {
  await withDatabase(async (database) => {
    await database.exec(schemaSql);
    await database.exec('DROP TABLE operator_execution_authorizations;');
    const store = new PostgresSettlementStore({ database });

    await assert.rejects(store.initialize({ migrate: false }), {
      message: /Missing: operator_execution_authorizations\./,
    });
  });
});

test('a fully migrated schema passes readiness and still runs no DDL', async () => {
  await withDatabase(async (database) => {
    await new PostgresSettlementStore({ database }).initialize({ migrate: true });
    const audited = auditedDatabase(database);

    await new PostgresSettlementStore({ database: audited }).initialize({ migrate: false });

    assert.equal(
      audited.statements.some((statement) => ddlPattern.test(statement)),
      false,
      'migrations-disabled startup performs no DDL',
    );
    assert.equal(audited.statements.length, 1, 'readiness is a single catalog read');
  });
});

test('the migration creates every column the runtime declares it requires', async () => {
  await withDatabase(async (database) => {
    await new PostgresSettlementStore({ database }).initialize({ migrate: true });
    const result = await database.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [requiredTables],
    );
    const present = new Map();
    for (const row of result.rows) {
      if (!present.has(row.table_name)) present.set(row.table_name, new Set());
      present.get(row.table_name).add(row.column_name);
    }
    for (const [table, columns] of Object.entries(requiredColumns)) {
      for (const column of columns) {
        assert.equal(present.get(table)?.has(column), true, `${table}.${column} must exist`);
      }
    }
  });
});

test('an upgrade from the pre-claim layout succeeds once the migration has run', async () => {
  await withDatabase(async (database) => {
    await database.exec(legacySettlementsSql);
    // The one-shot migration identity is the only DDL-capable identity, and it is additive.
    await new PostgresSettlementStore({ database }).initialize({ migrate: true });
    await new PostgresSettlementStore({ database }).initialize({ migrate: false });
  });
});

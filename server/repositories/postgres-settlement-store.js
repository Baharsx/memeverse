import { readFile } from 'node:fs/promises';
import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { DomainError } from '../domain/errors.js';

const { Pool } = pg;
const terminalStates = new Set(['COMPLETE', 'DENIED', 'EXPIRED', 'CANCELLED', 'FAILED']);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function recordFromRow(row) {
  return clone(typeof row.record === 'string' ? JSON.parse(row.record) : row.record);
}

function reservationForCreate(record, reservedUnits, treasuryAvailableUnits) {
  if (!record.policy?.approved) return null;
  const requestedUnits = BigInt(record.amount.creatorPayoutUnits);
  if (treasuryAvailableUnits !== undefined
    && reservedUnits + requestedUnits > BigInt(treasuryAvailableUnits)) {
    throw new DomainError(
      'TREASURY_CAPACITY_EXCEEDED',
      'Available Arc USDC is already reserved by active settlements.',
      {
        status: 409,
        details: {
          availableUnits: BigInt(treasuryAvailableUnits).toString(),
          reservedUnits: reservedUnits.toString(),
          requestedUnits: requestedUnits.toString(),
        },
      },
    );
  }
  return {
    units: requestedUnits.toString(),
    status: 'ACTIVE',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function updateReservation(record) {
  if (!record.reservation) return record;
  let status = record.reservation.status;
  if (record.state === 'COMPLETE') status = 'CONSUMED';
  else if (terminalStates.has(record.state)) status = 'RELEASED';
  return {
    ...record,
    reservation: { ...record.reservation, status, updatedAt: record.updatedAt },
  };
}

class PoolDatabase {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString, max: 10 });
    this.supportsAdvisoryLocks = true;
  }

  query(text, params) {
    return this.pool.query(text, params);
  }

  exec(text) {
    return this.pool.query(text);
  }

  async transaction(operation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  close() {
    return this.pool.end();
  }
}

export class PostgresSettlementStore {
  constructor({ database, legacyDataFile }) {
    this.database = database;
    this.legacyDataFile = legacyDataFile;
    this.reservationQueue = Promise.resolve();
  }

  async initialize() {
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS settlements (
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
      CREATE INDEX IF NOT EXISTS settlements_state_idx ON settlements (state);
      CREATE INDEX IF NOT EXISTS settlements_created_at_idx ON settlements (created_at DESC);
      CREATE INDEX IF NOT EXISTS settlements_reconciliation_idx
        ON settlements (state, circle_transaction_id)
        WHERE circle_transaction_id IS NOT NULL;
    `);
    await this.importLegacyRecords();
  }

  async importLegacyRecords() {
    if (!this.legacyDataFile) return;
    const count = await this.database.query('SELECT count(*)::text AS count FROM settlements');
    if (count.rows[0]?.count !== '0') return;
    try {
      const payload = JSON.parse(await readFile(this.legacyDataFile, 'utf8'));
      for (const record of payload.settlements ?? []) {
        await this.insertLegacyRecord(record);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async insertLegacyRecord(record) {
    const stored = record.reservation === undefined
      ? { ...record, reservation: record.policy?.approved ? {
        units: record.amount.creatorPayoutUnits,
        status: terminalStates.has(record.state) ? 'RELEASED' : 'ACTIVE',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      } : null }
      : record;
    await this.database.query(
      `INSERT INTO settlements (
        id, idempotency_key, circle_transaction_id, state,
        reservation_units, reservation_status, record, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5::numeric, $6, $7::jsonb, $8::timestamptz, $9::timestamptz)
      ON CONFLICT DO NOTHING`,
      this.values(stored),
    );
  }

  values(record) {
    return [
      record.id,
      record.idempotencyKey,
      record.circle?.transactionId ?? null,
      record.state,
      record.reservation?.units ?? '0',
      record.reservation?.status ?? 'NONE',
      JSON.stringify(record),
      record.createdAt,
      record.updatedAt,
    ];
  }

  async list() {
    const result = await this.database.query('SELECT record FROM settlements ORDER BY created_at DESC');
    return result.rows.map(recordFromRow);
  }

  async get(id) {
    const result = await this.database.query('SELECT record FROM settlements WHERE id = $1', [id]);
    return result.rows[0] ? recordFromRow(result.rows[0]) : undefined;
  }

  async getByIdempotencyKey(key) {
    const result = await this.database.query(
      'SELECT record FROM settlements WHERE idempotency_key = $1',
      [key],
    );
    return result.rows[0] ? recordFromRow(result.rows[0]) : undefined;
  }

  async getByCircleTransactionId(id) {
    const result = await this.database.query(
      'SELECT record FROM settlements WHERE circle_transaction_id = $1',
      [id],
    );
    return result.rows[0] ? recordFromRow(result.rows[0]) : undefined;
  }

  async createIfAbsent(record, { treasuryAvailableUnits } = {}) {
    const operation = () => this.database.transaction(async (transaction) => {
      if (this.database.supportsAdvisoryLocks) {
        await transaction.query('SELECT pg_advisory_xact_lock($1)', [5042002]);
      }
      const existing = await transaction.query(
        'SELECT record FROM settlements WHERE idempotency_key = $1',
        [record.idempotencyKey],
      );
      if (existing.rows[0]) return { record: recordFromRow(existing.rows[0]), created: false };

      const aggregate = await transaction.query(
        `SELECT COALESCE(sum(reservation_units), 0)::text AS units
         FROM settlements
         WHERE reservation_status = 'ACTIVE'
           AND (
             state NOT IN ('PREPARED', 'AWAITING_SIGNATURE')
             OR NULLIF(record->>'expiresAt', '') IS NULL
             OR NULLIF(record->>'expiresAt', '')::timestamptz > now()
           )`,
      );
      const reservation = reservationForCreate(
        record,
        BigInt(aggregate.rows[0]?.units ?? '0'),
        treasuryAvailableUnits,
      );
      const stored = { ...record, reservation };
      await transaction.query(
        `INSERT INTO settlements (
          id, idempotency_key, circle_transaction_id, state,
          reservation_units, reservation_status, record, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5::numeric, $6, $7::jsonb, $8::timestamptz, $9::timestamptz)`,
        this.values(stored),
      );
      return { record: clone(stored), created: true };
    });
    if (this.database.supportsAdvisoryLocks) return operation();

    const pending = this.reservationQueue.then(operation, operation);
    this.reservationQueue = pending.catch(() => undefined);
    return pending;
  }

  async update(record) {
    const stored = updateReservation(record);
    const result = await this.database.query(
      `UPDATE settlements SET
        idempotency_key = $2,
        circle_transaction_id = $3,
        state = $4,
        reservation_units = $5::numeric,
        reservation_status = $6,
        record = $7::jsonb,
        created_at = $8::timestamptz,
        updated_at = $9::timestamptz
       WHERE id = $1
       RETURNING record`,
      this.values(stored),
    );
    if (!result.rows[0]) {
      throw new DomainError('SETTLEMENT_NOT_FOUND', 'Settlement was not found.', { status: 404 });
    }
    return recordFromRow(result.rows[0]);
  }

  async listReconciliationCandidates() {
    const result = await this.database.query(
      `SELECT record FROM settlements
       WHERE circle_transaction_id IS NOT NULL
         AND state NOT IN ('COMPLETE', 'FAILED', 'DENIED', 'CANCELLED')
       ORDER BY updated_at ASC
       LIMIT 100`,
    );
    return result.rows.map(recordFromRow);
  }

  close() {
    return this.database.close?.();
  }
}

export function createPostgresSettlementStore(config) {
  let database;
  if (config.databaseUrl) {
    database = new PoolDatabase(config.databaseUrl);
  } else {
    mkdirSync(config.pgliteDataDir, { recursive: true, mode: 0o700 });
    chmodSync(config.pgliteDataDir, 0o700);
    database = new PGlite(config.pgliteDataDir);
  }
  return new PostgresSettlementStore({ database, legacyDataFile: config.dataFile });
}

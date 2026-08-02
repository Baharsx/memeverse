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

function reservationForCreate(
  record,
  reservedUnits,
  treasuryAvailableUnits,
  agentDailyUsedUnits,
  agentDailyCapUnits,
) {
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
  if (agentDailyCapUnits !== undefined
    && agentDailyUsedUnits + requestedUnits > BigInt(agentDailyCapUnits)) {
    throw new DomainError(
      'AGENT_DAILY_CAP_EXCEEDED',
      'The agent daily payout cap has been reached.',
      {
        status: 409,
        details: {
          dailyCapUnits: BigInt(agentDailyCapUnits).toString(),
          dailyUsedUnits: agentDailyUsedUnits.toString(),
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
  else if (record.state === 'FAILED' && (record.broadcast || record.circle?.transactionId)) status = 'HELD';
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
  constructor({ database, legacyDataFile, legacyNotificationFile }) {
    this.database = database;
    this.legacyDataFile = legacyDataFile;
    this.legacyNotificationFile = legacyNotificationFile;
    this.reservationQueue = Promise.resolve();
    this.notificationQueue = Promise.resolve();
  }

  async initialize({ migrate = true } = {}) {
    if (!migrate) {
      const result = await this.database.query(
        `SELECT to_regclass('public.settlements') IS NOT NULL AS settlements_ready,
                to_regclass('public.circle_notifications') IS NOT NULL AS notifications_ready`,
      );
      if (!result.rows[0]?.settlements_ready || !result.rows[0]?.notifications_ready) {
        throw new Error('Database schema is missing. Run npm run db:migrate first.');
      }
      return;
    }
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
        updated_at timestamptz NOT NULL,
        reconciliation_lease_owner text,
        reconciliation_lease_until timestamptz
      );
      ALTER TABLE settlements
        ADD COLUMN IF NOT EXISTS reconciliation_lease_owner text,
        ADD COLUMN IF NOT EXISTS reconciliation_lease_until timestamptz;
      CREATE TABLE IF NOT EXISTS circle_notifications (
        notification_id text PRIMARY KEY,
        processed_at timestamptz NOT NULL,
        outcome jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS settlements_state_idx ON settlements (state);
      CREATE INDEX IF NOT EXISTS settlements_created_at_idx ON settlements (created_at DESC);
      CREATE INDEX IF NOT EXISTS settlements_reconciliation_idx
        ON settlements (state, circle_transaction_id)
        WHERE circle_transaction_id IS NOT NULL;
    `);
    await this.importLegacyRecords();
    await this.importLegacyNotifications();
  }

  async importLegacyNotifications() {
    if (!this.legacyNotificationFile) return;
    const count = await this.database.query('SELECT count(*)::text AS count FROM circle_notifications');
    if (count.rows[0]?.count !== '0') return;
    try {
      const payload = JSON.parse(await readFile(this.legacyNotificationFile, 'utf8'));
      for (const receipt of payload.notifications ?? []) {
        await this.database.query(
          `INSERT INTO circle_notifications (notification_id, processed_at, outcome)
           VALUES ($1, $2::timestamptz, $3::jsonb)
           ON CONFLICT DO NOTHING`,
          [receipt.notificationId, receipt.processedAt, JSON.stringify(receipt.outcome)],
        );
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
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
    const legacyReservationStatus = record.state === 'COMPLETE'
      ? 'CONSUMED'
      : record.state === 'FAILED' && (record.broadcast || record.circle?.transactionId)
        ? 'HELD'
        : terminalStates.has(record.state) ? 'RELEASED' : 'ACTIVE';
    const stored = record.reservation === undefined
      ? { ...record, reservation: record.policy?.approved ? {
        units: record.amount.creatorPayoutUnits,
        status: legacyReservationStatus,
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

  async createIfAbsent(record, { treasuryAvailableUnits, agentDailyCapUnits } = {}) {
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
         WHERE reservation_status IN ('ACTIVE', 'HELD')
           AND (
             state NOT IN ('PREPARED', 'AWAITING_SIGNATURE')
             OR NULLIF(record->>'expiresAt', '') IS NULL
             OR NULLIF(record->>'expiresAt', '')::timestamptz > now()
           )`,
      );
      const dailyAggregate = agentDailyCapUnits === undefined
        ? { rows: [{ units: '0' }] }
        : await transaction.query(
          `SELECT COALESCE(sum(reservation_units), 0)::text AS units
           FROM settlements
           WHERE record->'agentDecision' IS NOT NULL
             AND reservation_status IN ('ACTIVE', 'HELD', 'CONSUMED')
             AND created_at >= date_trunc('day', $1::timestamptz)
             AND created_at < date_trunc('day', $1::timestamptz) + interval '1 day'`,
          [record.createdAt],
        );
      const reservation = reservationForCreate(
        record,
        BigInt(aggregate.rows[0]?.units ?? '0'),
        treasuryAvailableUnits,
        BigInt(dailyAggregate.rows[0]?.units ?? '0'),
        agentDailyCapUnits,
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

  async claimReconciliationCandidates({ owner, leaseSeconds = 30, limit = 100 }) {
    const result = await this.database.query(
      `WITH candidates AS (
         SELECT id
         FROM settlements
         WHERE circle_transaction_id IS NOT NULL
           AND state NOT IN ('COMPLETE', 'FAILED', 'DENIED', 'CANCELLED')
           AND (reconciliation_lease_until IS NULL OR reconciliation_lease_until <= now())
         ORDER BY updated_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE settlements AS settlement
       SET reconciliation_lease_owner = $2,
           reconciliation_lease_until = now() + ($3::text || ' seconds')::interval
       FROM candidates
       WHERE settlement.id = candidates.id
       RETURNING settlement.record`,
      [limit, owner, leaseSeconds],
    );
    return result.rows.map(recordFromRow);
  }

  async releaseReconciliationLease(id, owner) {
    await this.database.query(
      `UPDATE settlements
       SET reconciliation_lease_owner = NULL, reconciliation_lease_until = NULL
       WHERE id = $1 AND reconciliation_lease_owner = $2`,
      [id, owner],
    );
  }

  async processOnce(notificationId, operation) {
    const process = async (database) => {
      const existing = await database.query(
        'SELECT notification_id, processed_at, outcome FROM circle_notifications WHERE notification_id = $1',
        [notificationId],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        return {
          receipt: {
            notificationId: row.notification_id,
            processedAt: new Date(row.processed_at).toISOString(),
            outcome: clone(typeof row.outcome === 'string' ? JSON.parse(row.outcome) : row.outcome),
          },
          replayed: true,
        };
      }
      const outcome = await operation();
      const processedAt = new Date().toISOString();
      await database.query(
        `INSERT INTO circle_notifications (notification_id, processed_at, outcome)
         VALUES ($1, $2::timestamptz, $3::jsonb)`,
        [notificationId, processedAt, JSON.stringify(outcome)],
      );
      return { receipt: { notificationId, processedAt, outcome }, replayed: false };
    };

    if (this.database.supportsAdvisoryLocks) {
      return this.database.transaction(async (transaction) => {
        await transaction.query('SELECT pg_advisory_xact_lock(hashtext($1))', [notificationId]);
        return process(transaction);
      });
    }
    const pending = this.notificationQueue.then(() => process(this.database));
    this.notificationQueue = pending.catch(() => undefined);
    return pending;
  }

  async health() {
    const result = await this.database.query('SELECT 1 AS ready');
    return result.rows[0]?.ready === 1;
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
  return new PostgresSettlementStore({
    database,
    legacyDataFile: config.dataFile,
    legacyNotificationFile: config.circleNotificationDataFile,
  });
}

import { readFile } from 'node:fs/promises';
import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { activeExecutionClaim, isExecutionCommitted } from '../domain/execution-claim.js';
import { DomainError } from '../domain/errors.js';
import { requiredColumns, requiredTables, schemaSql } from './schema.js';

const { Pool } = pg;
const terminalStates = new Set(['COMPLETE', 'DENIED', 'EXPIRED', 'CANCELLED', 'FAILED']);

/** Explains a lost claim from the row as it actually stands, never from the caller's snapshot. */
export function claimRejection(row, expectedVersion, nowIso) {
  if (!row) return { outcome: 'NOT_FOUND' };
  const current = {
    version: Number(row.version),
    state: row.state,
    circleTransactionId: row.circle_transaction_id ?? null,
    claimId: row.execution_claim_id ?? null,
    claimUntil: row.execution_claim_until ? new Date(row.execution_claim_until).toISOString() : null,
  };
  if (current.circleTransactionId) return { outcome: 'ALREADY_SUBMITTED', current };
  if (current.state !== 'AWAITING_SIGNATURE') return { outcome: 'NOT_EXECUTABLE', current };
  if (current.claimId && current.claimUntil
    && new Date(current.claimUntil).getTime() > new Date(nowIso).getTime()) {
    return { outcome: 'ALREADY_CLAIMED', current };
  }
  // The row is still claimable, so the caller simply read an older version of it.
  return { outcome: 'VERSION_CONFLICT', current };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

/**
 * The row version is authoritative and is projected onto the returned record so every caller
 * carries the version it read into its next write.
 */
function recordFromRow(row) {
  const record = clone(typeof row.record === 'string' ? JSON.parse(row.record) : row.record);
  if (record && row.version !== undefined && row.version !== null) {
    record.version = Number(row.version);
  }
  return record;
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

/**
 * Reservation accounting, and the last line of defence for treasury capacity.
 *
 * A terminal state normally returns the reservation to the treasury, but never while execution
 * is committed: if Circle may already have accepted the payout, the capacity is spent whatever
 * the application state says, so it is HELD for investigation instead of released.
 */
function updateReservation(record) {
  if (!record.reservation) return record;
  let status = record.reservation.status;
  if (record.state === 'COMPLETE') status = 'CONSUMED';
  else if (terminalStates.has(record.state)) {
    status = record.broadcast || isExecutionCommitted(record) ? 'HELD' : 'RELEASED';
  }
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
      await this.assertSchemaReady();
      return;
    }
    await this.database.exec(schemaSql);
    await this.importLegacyRecords();
    await this.importLegacyNotifications();
  }

  /**
   * Startup readiness for a runtime that is not allowed to run DDL.
   *
   * Table existence alone is not readiness. A database carrying an older `settlements` layout
   * satisfies `to_regclass` and then fails on the first write, which is the worst possible time
   * to discover it — a settlement is already in flight. Every column the running code writes is
   * therefore verified here, and a shortfall stops the process before it serves a request.
   * This method only reads the catalog; the one-shot migration identity remains the sole writer
   * of schema.
   */
  async assertSchemaReady() {
    const result = await this.database.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [requiredTables],
    );
    const present = new Map();
    for (const row of result.rows) {
      if (!present.has(row.table_name)) present.set(row.table_name, new Set());
      present.get(row.table_name).add(row.column_name);
    }

    const missing = [];
    for (const table of requiredTables) {
      const columns = present.get(table);
      if (!columns) {
        missing.push(table);
        continue;
      }
      for (const column of requiredColumns[table]) {
        if (!columns.has(column)) missing.push(`${table}.${column}`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Database schema is outdated. Run npm run db:migrate. Missing: ${missing.join(', ')}.`,
      );
    }
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
        reservation_units, reservation_status, record, created_at, updated_at,
        execution_claim_id, execution_claim_until
      ) VALUES ($1, $2, $3, $4, $5::numeric, $6, $7::jsonb, $8::timestamptz, $9::timestamptz,
                $10, $11::timestamptz)
      ON CONFLICT DO NOTHING`,
      this.values(stored),
    );
  }

  values(record) {
    // The version lives in its own column; keeping it out of the document avoids two
    // competing sources of truth. The claim columns are projected from the document so every
    // write path keeps them consistent with the persisted submission.
    const { version: _version, ...persisted } = record;
    const claim = activeExecutionClaim(record);
    return [
      record.id,
      record.idempotencyKey,
      record.circle?.transactionId ?? null,
      record.state,
      record.reservation?.units ?? '0',
      record.reservation?.status ?? 'NONE',
      JSON.stringify(persisted),
      record.createdAt,
      record.updatedAt,
      claim?.claimId ?? null,
      claim?.leaseExpiresAt ?? null,
    ];
  }

  async list() {
    const result = await this.database.query(
      'SELECT record, version FROM settlements ORDER BY created_at DESC',
    );
    return result.rows.map(recordFromRow);
  }

  async get(id) {
    const result = await this.database.query(
      'SELECT record, version FROM settlements WHERE id = $1',
      [id],
    );
    return result.rows[0] ? recordFromRow(result.rows[0]) : undefined;
  }

  async getByIdempotencyKey(key) {
    const result = await this.database.query(
      'SELECT record, version FROM settlements WHERE idempotency_key = $1',
      [key],
    );
    return result.rows[0] ? recordFromRow(result.rows[0]) : undefined;
  }

  async getByCircleTransactionId(id) {
    const result = await this.database.query(
      'SELECT record, version FROM settlements WHERE circle_transaction_id = $1',
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
        'SELECT record, version FROM settlements WHERE idempotency_key = $1',
        [record.idempotencyKey],
      );
      if (existing.rows[0]) return { record: recordFromRow(existing.rows[0]), created: false };

      // A lapsed quote frees its capacity, but only while nothing has been executed against it.
      // A settlement whose execution is claimed, undetermined, or submitted keeps counting no
      // matter how old its quote is: Circle may already have accepted that payout.
      const aggregate = await transaction.query(
        `SELECT COALESCE(sum(reservation_units), 0)::text AS units
         FROM settlements
         WHERE reservation_status IN ('ACTIVE', 'HELD')
           AND (
             state NOT IN ('PREPARED', 'AWAITING_SIGNATURE')
             OR NULLIF(record->>'expiresAt', '') IS NULL
             OR NULLIF(record->>'expiresAt', '')::timestamptz > now()
             OR circle_transaction_id IS NOT NULL
             OR record->'executionSubmission'->>'status'
                  IN ('CLAIMED', 'UNKNOWN_OUTCOME', 'SUBMITTED')
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
          reservation_units, reservation_status, record, created_at, updated_at,
          execution_claim_id, execution_claim_until
        ) VALUES ($1, $2, $3, $4, $5::numeric, $6, $7::jsonb, $8::timestamptz, $9::timestamptz,
                  $10, $11::timestamptz)`,
        this.values(stored),
      );
      return { record: { ...clone(stored), version: 0 }, created: true };
    });
    if (this.database.supportsAdvisoryLocks) return operation();

    const pending = this.reservationQueue.then(operation, operation);
    this.reservationQueue = pending.catch(() => undefined);
    return pending;
  }

  /**
   * Optimistic concurrency: the write only lands when the row still holds the version the
   * caller read. A losing writer receives `SETTLEMENT_VERSION_CONFLICT` and must reload and
   * re-evaluate rather than overwrite newer evidence.
   */
  async update(record) {
    const stored = updateReservation(record);
    const expectedVersion = Number(record.version ?? 0);
    const result = await this.database.query(
      `UPDATE settlements SET
        idempotency_key = $2,
        circle_transaction_id = $3,
        state = $4,
        reservation_units = $5::numeric,
        reservation_status = $6,
        record = $7::jsonb,
        created_at = $8::timestamptz,
        updated_at = $9::timestamptz,
        execution_claim_id = $10,
        execution_claim_until = $11::timestamptz,
        version = version + 1
       WHERE id = $1 AND version = $12::bigint
       RETURNING record, version`,
      [...this.values(stored), expectedVersion],
    );
    if (result.rows[0]) return recordFromRow(result.rows[0]);

    const current = await this.database.query('SELECT version FROM settlements WHERE id = $1', [record.id]);
    if (!current.rows[0]) {
      throw new DomainError('SETTLEMENT_NOT_FOUND', 'Settlement was not found.', { status: 404 });
    }
    throw new DomainError(
      'SETTLEMENT_VERSION_CONFLICT',
      'The settlement was modified by another writer.',
      {
        status: 409,
        details: { expectedVersion, currentVersion: Number(current.rows[0].version) },
      },
    );
  }

  /**
   * The single atomic gate in front of the external Circle call.
   *
   * The write lands only when the row is still the exact one the caller read, is still awaiting
   * signature, has no provider transaction, and carries no unexpired execution claim. Losers are
   * told precisely why they lost so the domain can reconcile, reject, or retry deliberately.
   * The provider call happens after this commits, never inside a transaction.
   */
  async claimExecution({ record, expectedVersion, nowIso }) {
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
        updated_at = $9::timestamptz,
        execution_claim_id = $10,
        execution_claim_until = $11::timestamptz,
        version = version + 1
       WHERE id = $1
         AND version = $12::bigint
         AND state = 'AWAITING_SIGNATURE'
         AND circle_transaction_id IS NULL
         AND (execution_claim_id IS NULL OR execution_claim_until <= $13::timestamptz)
       RETURNING record, version`,
      [...this.values(stored), Number(expectedVersion ?? 0), nowIso],
    );
    if (result.rows[0]) return { outcome: 'CLAIMED', record: recordFromRow(result.rows[0]) };

    const current = await this.database.query(
      `SELECT record, version, state, circle_transaction_id,
              execution_claim_id, execution_claim_until
       FROM settlements WHERE id = $1`,
      [record.id],
    );
    return claimRejection(current.rows[0], expectedVersion, nowIso);
  }

  /**
   * Extends a live claim's lease, and nothing else.
   *
   * Ownership is proven by the database, not by the caller: the write lands only when the row
   * still carries this exact claim ID, still has no provider transaction, and is still awaiting
   * signature. A process that has lost the claim cannot renew it, and no caller can renew a
   * claim it never held.
   *
   * `version` is bumped so a concurrent writer holding an older snapshot loses its optimistic
   * update and reloads instead of overwriting the fresh lease with a stale one. `updated_at` is
   * deliberately untouched: a lease renewal is not a change to the settlement, and reconciliation
   * ordering must not be disturbed by it. No history is appended, so a long provider call cannot
   * flood the audit trail.
   */
  async renewExecutionClaim({ settlementId, claimId, leaseUntil }) {
    const result = await this.database.query(
      `UPDATE settlements SET
        execution_claim_until = $3::text::timestamptz,
        record = jsonb_set(record, '{executionSubmission,leaseExpiresAt}', to_jsonb($3::text)),
        version = version + 1
       WHERE id = $1
         AND execution_claim_id = $2
         AND circle_transaction_id IS NULL
         AND state = 'AWAITING_SIGNATURE'
       RETURNING record, version`,
      [settlementId, claimId, leaseUntil],
    );
    if (result.rows[0]) return { outcome: 'RENEWED', record: recordFromRow(result.rows[0]) };

    const current = await this.database.query(
      'SELECT state, circle_transaction_id, execution_claim_id FROM settlements WHERE id = $1',
      [settlementId],
    );
    const row = current.rows[0];
    if (!row) return { outcome: 'NOT_FOUND' };
    if (row.circle_transaction_id) return { outcome: 'ALREADY_SUBMITTED' };
    if (row.state !== 'AWAITING_SIGNATURE') return { outcome: 'NOT_EXECUTABLE' };
    return { outcome: 'OWNERSHIP_LOST' };
  }

  async listReconciliationCandidates() {
    const result = await this.database.query(
      `SELECT record, version FROM settlements
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
       RETURNING settlement.record, settlement.version`,
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

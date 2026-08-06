import { applySpendCaps } from '../domain/agent-payout.js';
import { DomainError } from '../domain/errors.js';

/**
 * Durable, cluster-wide state for the autonomous agent: the pause switch, the per-market payout
 * epoch claims that implement cooldown, and the collector's block checkpoints.
 *
 * All of it lives in PostgreSQL rather than process memory because MemeVerse runs multiple API
 * and worker processes. An in-memory mutex would let two workers pay the same creator twice, and
 * an environment variable cannot be flipped fast enough — or consistently enough — to serve as
 * an emergency stop across a cluster.
 */

const CONTROL_ID = 'autonomy';

/**
 * Advisory lock key for autonomous spend admission.
 *
 * Deliberately different from the settlement treasury reservation's key: the autonomous daily cap
 * and the treasury reservation are two independent controls over two different questions ("may
 * the agent spend more today?" versus "does the wallet hold enough for this settlement?"). They
 * must not be double-counted against each other, and they must not contend for one lock.
 */
const SPEND_ADMISSION_LOCK_KEY = 5042003;

export const spendReservationStatuses = Object.freeze({
  RESERVED: 'RESERVED',
  CONSUMED: 'CONSUMED',
  RELEASED: 'RELEASED',
});

/** Statuses that still occupy daily capacity. A released reservation occupies nothing. */
const OCCUPYING_STATUSES = [
  spendReservationStatuses.RESERVED,
  spendReservationStatuses.CONSUMED,
];

/** The UTC day a spend belongs to. Caps are measured per UTC calendar day. */
export function spendDayOf(date) {
  return date.toISOString().slice(0, 10);
}

/** Deterministic reservation identity: one admission per market, policy version, and epoch. */
export function spendReservationId({ policyVersion, marketAddress, epoch }) {
  return `${policyVersion}:${marketAddress.toLowerCase()}:${epoch}`;
}

export class AgentAutonomyStore {
  constructor({ database, now = () => new Date() }) {
    this.database = database;
    this.now = now;
    // Serialises admission when the database cannot offer advisory locks. PGlite runs one
    // connection in one process, so a promise chain is a sufficient and honest substitute there;
    // real PostgreSQL uses a transaction-scoped advisory lock instead and works across processes.
    this.admissionQueue = Promise.resolve();
  }

  /**
   * Reads the autonomy switch, failing safe.
   *
   * A missing row means the control was never provisioned, which is treated as paused. Autonomy
   * must be switched on deliberately; it can never default itself into spending money.
   */
  async autonomyState() {
    const result = await this.database.query(
      'SELECT paused, reason, changed_by, changed_at FROM agent_runtime_control WHERE id = $1',
      [CONTROL_ID],
    );
    const row = result.rows[0];
    if (!row) {
      return {
        paused: true, reason: 'AUTONOMY_NOT_PROVISIONED', changedBy: null, changedAt: null,
      };
    }
    return {
      paused: row.paused === true || row.paused === 't',
      reason: row.reason ?? null,
      changedBy: row.changed_by ?? null,
      changedAt: row.changed_at ? new Date(row.changed_at).toISOString() : null,
    };
  }

  /** Sets the switch. Only an authenticated operator ever reaches this from the transport. */
  async setAutonomyPaused({ paused, reason = null, changedBy = null }) {
    const nowIso = this.now().toISOString();
    await this.database.query(
      `INSERT INTO agent_runtime_control (id, paused, reason, changed_by, changed_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         paused = EXCLUDED.paused,
         reason = EXCLUDED.reason,
         changed_by = EXCLUDED.changed_by,
         changed_at = EXCLUDED.changed_at`,
      [CONTROL_ID, paused, reason, changedBy, nowIso],
    );
    return this.autonomyState();
  }

  /**
   * Claims one (market, policy version, epoch) for this worker.
   *
   * The primary key does the work: concurrent workers racing on the same epoch produce exactly
   * one insert, and every loser is told who won. This is both the cooldown and the duplicate
   * payout guard — a market cannot be paid twice in an epoch because the second claim cannot
   * exist.
   */
  async claimPayoutEpoch({
    marketAddress, policyVersion, epoch, evidenceDigest, creatorAddress, claimedBy,
  }) {
    const nowIso = this.now().toISOString();
    const result = await this.database.query(
      `INSERT INTO agent_payout_epochs (
         market_address, policy_version, epoch, evidence_digest,
         creator_address, claimed_by, claimed_at
       ) VALUES ($1, $2, $3::bigint, $4, $5, $6, $7::timestamptz)
       ON CONFLICT (market_address, policy_version, epoch) DO NOTHING
       RETURNING market_address`,
      [
        marketAddress.toLowerCase(), policyVersion, String(epoch), evidenceDigest,
        creatorAddress.toLowerCase(), claimedBy, nowIso,
      ],
    );
    if (result.rows[0]) return { outcome: 'CLAIMED', epoch };

    const existing = await this.getPayoutEpoch({ marketAddress, policyVersion, epoch });
    return { outcome: 'ALREADY_CLAIMED', epoch, existing };
  }

  async getPayoutEpoch({ marketAddress, policyVersion, epoch }) {
    const result = await this.database.query(
      `SELECT market_address, policy_version, epoch, evidence_digest, settlement_id,
              creator_address, amount_units, claimed_by, claimed_at, resolved_at, outcome
       FROM agent_payout_epochs
       WHERE market_address = $1 AND policy_version = $2 AND epoch = $3::bigint`,
      [marketAddress.toLowerCase(), policyVersion, String(epoch)],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      marketAddress: row.market_address,
      policyVersion: row.policy_version,
      epoch: Number(row.epoch),
      evidenceDigest: row.evidence_digest,
      settlementId: row.settlement_id ?? null,
      creatorAddress: row.creator_address,
      amountUnits: BigInt(row.amount_units ?? 0),
      claimedBy: row.claimed_by,
      claimedAt: new Date(row.claimed_at).toISOString(),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
      outcome: row.outcome ?? null,
    };
  }

  /** Records what became of a claimed epoch, so a restart can tell finished work from lost work. */
  async resolvePayoutEpoch({
    marketAddress, policyVersion, epoch, settlementId = null, amountUnits = 0n, outcome,
  }) {
    const nowIso = this.now().toISOString();
    await this.database.query(
      `UPDATE agent_payout_epochs
       SET settlement_id = COALESCE($4, settlement_id),
           amount_units = $5::numeric,
           resolved_at = $6::timestamptz,
           outcome = $7
       WHERE market_address = $1 AND policy_version = $2 AND epoch = $3::bigint`,
      [
        marketAddress.toLowerCase(), policyVersion, String(epoch),
        settlementId, amountUnits.toString(), nowIso, outcome,
      ],
    );
  }

  /**
   * Sums what this market, and the agent overall, have already committed today.
   *
   * Only epochs that resolved into a real settlement count. A denied or abandoned evaluation
   * never consumed treasury, so it must not consume cap either.
   */
  async spentTodayUnits({ marketAddress, sinceIso }) {
    const result = await this.database.query(
      `SELECT
         COALESCE(sum(amount_units) FILTER (WHERE market_address = $1), 0)::text AS market_units,
         COALESCE(sum(amount_units), 0)::text AS global_units
       FROM agent_payout_epochs
       WHERE claimed_at >= $2::timestamptz
         AND settlement_id IS NOT NULL
         AND (outcome IS NULL OR outcome <> 'FAILED')`,
      [marketAddress.toLowerCase(), sinceIso],
    );
    const row = result.rows[0] ?? { market_units: '0', global_units: '0' };
    return {
      marketUnits: BigInt(row.market_units),
      globalUnits: BigInt(row.global_units),
    };
  }

  /**
   * Atomically admits an autonomous payout against the daily caps.
   *
   * This is the fix for a real cross-market race. Reading "spent so far" and then applying caps
   * in application memory is safe only while every contender collides on one database key. The
   * payout-epoch key does that for a single market, but the *global* daily cap spans all markets,
   * so two workers evaluating different markets could each read a global total of zero and each
   * approve a full payout — overspending the global cap by a factor of the worker count.
   *
   * Admission therefore happens inside one transaction that holds an exclusive lock, so the read
   * of current commitments and the write that extends them cannot interleave with another
   * admission. Whoever loses the race sees the winner's reservation already counted.
   *
   * Caps are expressed in what the creator receives, which is exactly what leaves the wallet.
   */
  async reserveDailySpend({
    marketAddress, policyVersion, epoch, requestedUnits, policy, now = this.now(),
  }) {
    const reservationId = spendReservationId({ policyVersion, marketAddress, epoch });
    const spendDay = spendDayOf(now);
    const nowIso = now.toISOString();

    const operation = () => this.database.transaction(async (transaction) => {
      if (this.database.supportsAdvisoryLocks) {
        // Held for the life of this transaction, across every process and connection.
        await transaction.query('SELECT pg_advisory_xact_lock($1)', [SPEND_ADMISSION_LOCK_KEY]);
      }

      // A restart, retry, or resumed evaluation must find its own prior admission rather than
      // reserving a second time against the same epoch.
      const existing = await transaction.query(
        `SELECT id, amount_units, status, settlement_id
         FROM agent_spend_reservations WHERE id = $1`,
        [reservationId],
      );
      // A reservation that still occupies capacity is returned as-is, which is what makes a
      // restart or a resumed evaluation idempotent rather than double-reserving.
      if (existing.rows[0] && existing.rows[0].status !== spendReservationStatuses.RELEASED) {
        const row = existing.rows[0];
        return {
          outcome: 'ALREADY_RESERVED',
          reservationId,
          amountUnits: BigInt(row.amount_units),
          status: row.status,
          settlementId: row.settlement_id ?? null,
        };
      }
      // A released row occupies nothing, so returning it as though it did would hand the caller
      // capacity it does not hold. It is re-admitted through the caps below instead. The epoch
      // claim makes this unreachable today; it is closed so it cannot become reachable later.
      const reAdmitting = Boolean(existing.rows[0]);

      const committed = await transaction.query(
        `SELECT
           COALESCE(sum(amount_units) FILTER (WHERE market_address = $2), 0)::text AS market_units,
           COALESCE(sum(amount_units), 0)::text AS global_units
         FROM agent_spend_reservations
         WHERE spend_day = $1 AND status = ANY($3::text[])`,
        [spendDay, marketAddress.toLowerCase(), OCCUPYING_STATUSES],
      );
      const row = committed.rows[0] ?? { market_units: '0', global_units: '0' };

      const capped = applySpendCaps(requestedUnits, policy, {
        marketSpentTodayUnits: BigInt(row.market_units),
        globalSpentTodayUnits: BigInt(row.global_units),
      });
      if (!capped.approved) {
        // Nothing is written, so a denial never consumes capacity.
        return {
          outcome: 'DENIED',
          reservationId,
          amountUnits: 0n,
          reasons: capped.reasons,
          marketCommittedUnits: BigInt(row.market_units),
          globalCommittedUnits: BigInt(row.global_units),
        };
      }

      await transaction.query(
        `INSERT INTO agent_spend_reservations (
           id, spend_day, market_address, policy_version, epoch,
           amount_units, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5::bigint, $6::numeric, $7, $8::timestamptz, $8::timestamptz)
         ON CONFLICT (id) DO UPDATE SET
           spend_day = EXCLUDED.spend_day,
           amount_units = EXCLUDED.amount_units,
           status = EXCLUDED.status,
           settlement_id = NULL,
           updated_at = EXCLUDED.updated_at`,
        [
          reservationId, spendDay, marketAddress.toLowerCase(), policyVersion, String(epoch),
          capped.amountUnits.toString(), spendReservationStatuses.RESERVED, nowIso,
        ],
      );

      return {
        outcome: 'RESERVED',
        reservationId,
        amountUnits: capped.amountUnits,
        amountUsdc: capped.amountUsdc,
        reasons: capped.reasons,
        reAdmitted: reAdmitting,
      };
    });

    if (this.database.supportsAdvisoryLocks) return operation();
    const pending = this.admissionQueue.then(operation, operation);
    this.admissionQueue = pending.catch(() => undefined);
    return pending;
  }

  /**
   * Marks a reservation as really spent once a settlement exists.
   *
   * The amount is never re-derived here: the reservation already holds exactly the creator payout
   * that was admitted, so consumption cannot silently drift from what was checked against the cap.
   */
  async consumeDailySpend({ reservationId, settlementId }) {
    const nowIso = this.now().toISOString();
    const result = await this.database.query(
      `UPDATE agent_spend_reservations
       SET status = $2, settlement_id = COALESCE($3, settlement_id), updated_at = $4::timestamptz
       WHERE id = $1 AND status = $5
       RETURNING amount_units`,
      [
        reservationId, spendReservationStatuses.CONSUMED, settlementId, nowIso,
        spendReservationStatuses.RESERVED,
      ],
    );
    return {
      updated: result.rows.length > 0,
      amountUnits: result.rows[0] ? BigInt(result.rows[0].amount_units) : 0n,
    };
  }

  /**
   * Returns capacity to the day, and only when the payout provably did not spend.
   *
   * This is deliberately narrow. An undetermined provider outcome must keep holding capacity: the
   * money may already be moving, and freeing the budget on uncertainty is exactly how an agent
   * overspends its daily limit during an incident. Only a caller that can prove no provider call
   * happened may release.
   */
  async releaseDailySpend({ reservationId }) {
    const nowIso = this.now().toISOString();
    const result = await this.database.query(
      `UPDATE agent_spend_reservations
       SET status = $2, updated_at = $3::timestamptz
       WHERE id = $1 AND status = $4
       RETURNING amount_units`,
      [
        reservationId, spendReservationStatuses.RELEASED, nowIso,
        spendReservationStatuses.RESERVED,
      ],
    );
    return {
      updated: result.rows.length > 0,
      amountUnits: result.rows[0] ? BigInt(result.rows[0].amount_units) : 0n,
    };
  }

  /** Current daily commitment, for status surfaces and invariant assertions. */
  async dailySpendState({ marketAddress, now = this.now() } = {}) {
    const spendDay = spendDayOf(now);
    const result = await this.database.query(
      `SELECT
         COALESCE(sum(amount_units) FILTER (WHERE status = $2), 0)::text AS reserved_units,
         COALESCE(sum(amount_units) FILTER (WHERE status = $3), 0)::text AS consumed_units,
         COALESCE(sum(amount_units) FILTER (WHERE status = ANY($4::text[])), 0)::text AS committed_units,
         COALESCE(sum(amount_units) FILTER (
           WHERE status = ANY($4::text[]) AND ($5::text IS NULL OR market_address = $5)
         ), 0)::text AS market_committed_units
       FROM agent_spend_reservations WHERE spend_day = $1`,
      [
        spendDay,
        spendReservationStatuses.RESERVED,
        spendReservationStatuses.CONSUMED,
        OCCUPYING_STATUSES,
        marketAddress ? marketAddress.toLowerCase() : null,
      ],
    );
    const row = result.rows[0] ?? {};
    return {
      spendDay,
      reservedUnits: BigInt(row.reserved_units ?? 0),
      consumedUnits: BigInt(row.consumed_units ?? 0),
      committedUnits: BigInt(row.committed_units ?? 0),
      marketCommittedUnits: BigInt(row.market_committed_units ?? 0),
    };
  }

  async getSpendReservation(reservationId) {
    const result = await this.database.query(
      `SELECT id, spend_day, market_address, policy_version, epoch,
              amount_units, status, settlement_id, created_at, updated_at
       FROM agent_spend_reservations WHERE id = $1`,
      [reservationId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      spendDay: row.spend_day,
      marketAddress: row.market_address,
      policyVersion: row.policy_version,
      epoch: Number(row.epoch),
      amountUnits: BigInt(row.amount_units),
      status: row.status,
      settlementId: row.settlement_id ?? null,
    };
  }

  async getCheckpoint(marketAddress) {
    const result = await this.database.query(
      `SELECT market_address, last_scanned_block, last_block_hash, updated_at
       FROM agent_collector_checkpoints WHERE market_address = $1`,
      [marketAddress.toLowerCase()],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      marketAddress: row.market_address,
      lastScannedBlock: BigInt(row.last_scanned_block),
      lastBlockHash: row.last_block_hash ?? null,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  /** Advances a checkpoint monotonically; a stale worker can never rewind the scan cursor. */
  async saveCheckpoint({ marketAddress, lastScannedBlock, lastBlockHash }) {
    const nowIso = this.now().toISOString();
    await this.database.query(
      `INSERT INTO agent_collector_checkpoints (
         market_address, last_scanned_block, last_block_hash, updated_at
       ) VALUES ($1, $2::bigint, $3, $4::timestamptz)
       ON CONFLICT (market_address) DO UPDATE SET
         last_scanned_block = GREATEST(
           agent_collector_checkpoints.last_scanned_block, EXCLUDED.last_scanned_block
         ),
         last_block_hash = CASE
           WHEN EXCLUDED.last_scanned_block >= agent_collector_checkpoints.last_scanned_block
           THEN EXCLUDED.last_block_hash
           ELSE agent_collector_checkpoints.last_block_hash
         END,
         updated_at = EXCLUDED.updated_at`,
      [marketAddress.toLowerCase(), String(lastScannedBlock), lastBlockHash, nowIso],
    );
  }

  async listRecentEpochs(limit = 20) {
    const result = await this.database.query(
      `SELECT market_address, policy_version, epoch, evidence_digest, settlement_id,
              creator_address, amount_units, claimed_at, resolved_at, outcome
       FROM agent_payout_epochs ORDER BY claimed_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      marketAddress: row.market_address,
      policyVersion: row.policy_version,
      epoch: Number(row.epoch),
      evidenceDigest: row.evidence_digest,
      settlementId: row.settlement_id ?? null,
      creatorAddress: row.creator_address,
      amountUnits: BigInt(row.amount_units ?? 0),
      claimedAt: new Date(row.claimed_at).toISOString(),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
      outcome: row.outcome ?? null,
    }));
  }
}

export function requireAutonomyActive(state) {
  if (state.paused) {
    throw new DomainError('AUTONOMY_PAUSED', 'Autonomous settlement is paused.', {
      status: 409,
      details: { reason: state.reason ?? null },
    });
  }
  return state;
}

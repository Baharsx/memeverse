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

export class AgentAutonomyStore {
  constructor({ database, now = () => new Date() }) {
    this.database = database;
    this.now = now;
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

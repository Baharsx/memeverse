/**
 * Keeps a live provider call's execution claim from expiring underneath it.
 *
 * The claim lease exists so a *dead* claimant eventually frees its settlement. Without a
 * heartbeat the lease cannot tell a dead process from a slow one, so a Circle request that
 * outlives the lease would let a second authorized caller enter while the first request is still
 * alive. Renewing the lease from the process that is actually waiting on the provider makes the
 * distinction real: a healthy claimant keeps its lease, and a process that dies simply stops
 * beating, so its lease lapses on schedule and recovery proceeds exactly as before.
 *
 * Renewal is a database-level, ownership-conditional write. It is never inferred from an
 * in-memory flag, it never touches execution authority, and it appends no history, so a long
 * provider call cannot flood the audit trail.
 */
export const heartbeatOwnership = Object.freeze({
  HELD: 'HELD',
  LOST: 'LOST',
  UNPROVEN: 'UNPROVEN',
});

export class ExecutionClaimHeartbeat {
  constructor({
    store,
    settlementId,
    claimId,
    leaseSeconds,
    intervalSeconds,
    now,
    scheduler,
    maxConsecutiveFailures = 3,
    logger = console,
  }) {
    this.store = store;
    this.settlementId = settlementId;
    this.claimId = claimId;
    this.leaseSeconds = leaseSeconds;
    this.intervalSeconds = intervalSeconds;
    this.now = now;
    this.scheduler = scheduler;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.logger = logger;
    this.ownership = heartbeatOwnership.HELD;
    this.renewals = 0;
    this.consecutiveFailures = 0;
    this.stopped = false;
    this.timer = null;
    this.pending = null;
    this.lastOutcome = null;
  }

  /** No renewal mechanism means no heartbeat; the plain lease still bounds a lost claimant. */
  get supported() {
    return typeof this.store?.renewExecutionClaim === 'function'
      && this.intervalSeconds > 0;
  }

  start() {
    if (!this.supported || this.stopped) return this;
    this.schedule();
    return this;
  }

  schedule() {
    if (this.stopped) return;
    this.timer = this.scheduler.setTimer(() => this.beat(), this.intervalSeconds * 1000);
  }

  /**
   * One renewal. Ownership that cannot be proven ends the heartbeat rather than being assumed:
   * the caller is told, and the provider call it is already waiting on is left alone. A second
   * provider request is never created from here.
   */
  async beat() {
    if (this.stopped) return this.ownership;
    this.timer = null;
    this.pending = this.renew();
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
    return this.ownership;
  }

  async renew() {
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + this.leaseSeconds * 1000).toISOString();
    let outcome;
    try {
      const result = await this.store.renewExecutionClaim({
        settlementId: this.settlementId,
        claimId: this.claimId,
        leaseUntil,
        nowIso: now.toISOString(),
      });
      outcome = result?.outcome ?? 'OWNERSHIP_LOST';
    } catch (error) {
      // A transient storage failure is not proof of anything. Retry a bounded number of times;
      // only then treat ownership as unproven and stand down.
      this.consecutiveFailures += 1;
      this.lastOutcome = 'RENEWAL_FAILED';
      if (this.consecutiveFailures < this.maxConsecutiveFailures) {
        this.schedule();
        return;
      }
      this.logger.error?.(JSON.stringify({
        type: 'execution_claim_heartbeat_unproven',
        settlementId: this.settlementId,
        code: error?.code ?? 'EXECUTION_CLAIM_RENEWAL_FAILED',
      }));
      this.finish(heartbeatOwnership.UNPROVEN);
      return;
    }

    this.lastOutcome = outcome;
    if (outcome === 'RENEWED') {
      this.consecutiveFailures = 0;
      this.renewals += 1;
      this.schedule();
      return;
    }
    // The claim moved on, a provider transaction now exists, or the settlement left the
    // executable state. In every case this process is no longer the claim owner.
    this.finish(heartbeatOwnership.LOST);
  }

  finish(ownership) {
    this.ownership = ownership;
    this.stopped = true;
    if (this.timer !== null) {
      this.scheduler.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** Idempotent, and awaits any renewal already in flight so no write outlives the call. */
  async stop() {
    const pending = this.pending;
    this.stopped = true;
    if (this.timer !== null) {
      this.scheduler.clearTimer(this.timer);
      this.timer = null;
    }
    if (pending) await pending.catch(() => undefined);
    return this.ownership;
  }
}

/** Real timers, unreferenced so a heartbeat never holds the process open by itself. */
export const systemScheduler = Object.freeze({
  setTimer(handler, delayMs) {
    const timer = setTimeout(handler, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimer(timer) {
    clearTimeout(timer);
  },
});

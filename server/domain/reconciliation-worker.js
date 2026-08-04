export class ReconciliationWorker {
  constructor({
    store,
    settlementService,
    intervalMs = 5000,
    leaseSeconds = 30,
    owner = `worker-${process.pid}`,
    operatorAuthStore = null,
    authCleanupIntervalMs = 3_600_000,
    now = () => Date.now(),
    logger = console,
  }) {
    this.store = store;
    this.settlementService = settlementService;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.leaseSeconds = leaseSeconds;
    this.owner = owner;
    this.operatorAuthStore = operatorAuthStore;
    this.authCleanupIntervalMs = authCleanupIntervalMs;
    this.now = now;
    this.lastAuthCleanupAt = null;
    this.timer = null;
    this.running = null;
  }

  /**
   * Expired operator challenges, sessions, and approvals are swept from the supervised worker
   * rather than a job framework. Deletion is idempotent, so overlapping processes are harmless,
   * and a cleanup failure is logged without disturbing settlement reconciliation.
   */
  async purgeExpiredAuthRecords() {
    if (!this.operatorAuthStore) return false;
    const now = this.now();
    if (this.lastAuthCleanupAt !== null
      && now - this.lastAuthCleanupAt < this.authCleanupIntervalMs) return false;
    this.lastAuthCleanupAt = now;
    try {
      await this.operatorAuthStore.purgeExpired(new Date(now).toISOString());
      return true;
    } catch (error) {
      this.logger.error?.(JSON.stringify({
        type: 'auth_cleanup_error',
        code: error?.code ?? 'AUTH_CLEANUP_FAILED',
        message: error?.message ?? String(error),
      }));
      return false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  async tick() {
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => { this.running = null; });
    return this.running;
  }

  async runOnce() {
    await this.purgeExpiredAuthRecords();
    const records = this.store.claimReconciliationCandidates
      ? await this.store.claimReconciliationCandidates({
        owner: this.owner,
        leaseSeconds: this.leaseSeconds,
        limit: 100,
      })
      : await this.store.listReconciliationCandidates();
    for (const record of records) {
      try {
        await this.settlementService.reconcile(record.id);
      } catch (error) {
        this.logger.error?.(JSON.stringify({
          type: 'reconciliation_error',
          settlementId: record.id,
          code: error?.code ?? 'RECONCILIATION_FAILED',
          message: error?.message ?? String(error),
        }));
      } finally {
        await this.store.releaseReconciliationLease?.(record.id, this.owner);
      }
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}

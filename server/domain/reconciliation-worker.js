export class ReconciliationWorker {
  constructor({
    store,
    settlementService,
    intervalMs = 5000,
    leaseSeconds = 30,
    owner = `worker-${process.pid}`,
    logger = console,
  }) {
    this.store = store;
    this.settlementService = settlementService;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.leaseSeconds = leaseSeconds;
    this.owner = owner;
    this.timer = null;
    this.running = null;
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

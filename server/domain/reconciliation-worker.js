export class ReconciliationWorker {
  constructor({ store, settlementService, intervalMs = 5000, logger = console }) {
    this.store = store;
    this.settlementService = settlementService;
    this.intervalMs = intervalMs;
    this.logger = logger;
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
    const records = await this.store.listReconciliationCandidates();
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
      }
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}

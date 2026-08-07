import { DomainError } from './errors.js';

/**
 * The supervised loop that makes MemeVerse's creator settlement genuinely autonomous.
 *
 * On every tick it discovers the registered markets from the trusted factory and evaluates each
 * one in turn. Between a market becoming eligible and its creator being paid there is no human
 * step: the loop collects Arc evidence, runs policy, claims a payout epoch, quotes, prepares,
 * executes as the Circle Agent Wallet, and reconciles — all inside
 * `AutonomousAgentService.evaluateMarket`.
 *
 * Design notes that matter more than the loop itself:
 *
 *   * **Nothing here is a mutex.** Duplicate protection lives in PostgreSQL, in the payout-epoch
 *     primary key. Running ten of these workers is safe and is tested; the tenth simply loses
 *     every race and records `MARKET_IN_COOLDOWN`.
 *   * **Pause is checked twice** — once here before any work is created, and again inside the
 *     service immediately before the execution claim is taken.
 *   * **One market's failure never stops the sweep.** Errors are isolated per market so a single
 *     unreachable contract cannot starve every other creator.
 *   * **Ticks never overlap.** A slow tick delays the next one rather than running concurrently
 *     with itself, so a stuck provider call cannot fan out into repeated evaluation.
 *   * **Denials are summarised, not persisted per tick.** A market that is simply not eligible
 *     must not write a row every minute; only decisions that reach a settlement are durable.
 */
export class AutonomousAgentWorker {
  constructor({
    autonomousAgentService,
    autonomyStore,
    collector,
    intervalMs = 60_000,
    scheduler = { setTimer: setTimeout, clearTimer: clearTimeout },
    now = () => new Date(),
    logger = console,
    maxMarketsPerTick = 25,
  }) {
    this.service = autonomousAgentService;
    this.autonomyStore = autonomyStore;
    this.collector = collector;
    this.intervalMs = intervalMs;
    this.scheduler = scheduler;
    this.now = now;
    this.logger = logger;
    this.maxMarketsPerTick = maxMarketsPerTick;
    // Where the next sweep starts. Every tick was previously bounded by slicing from index zero,
    // so once the factory held more markets than the bound, everything past it would never be
    // evaluated — the sweep would re-read the same prefix forever. The cursor advances instead.
    this.sweepCursor = 0;
    this.timer = null;
    this.running = false;
    this.stopped = false;
    this.lastTick = null;
  }

  start() {
    this.stopped = false;
    this.#schedule();
    return this;
  }

  async stop() {
    this.stopped = true;
    if (this.timer !== null) {
      this.scheduler.clearTimer(this.timer);
      this.timer = null;
    }
    // Let an in-flight tick finish rather than abandoning a payout mid-flight; the settlement's
    // own claim and reconciliation would recover it, but a clean drain avoids the detour.
    while (this.running) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  #schedule() {
    if (this.stopped) return;
    // The handler returns its promise so a caller driving the scheduler can await a whole sweep,
    // and so a rescheduled tick is never observed before the previous one has finished.
    this.timer = this.scheduler.setTimer(() => {
      this.timer = null;
      return this.tick()
        .catch((error) => this.#log('agent_worker_tick_failed', { message: error?.message }))
        .finally(() => this.#schedule());
    }, this.intervalMs);
  }

  #log(type, fields = {}) {
    this.logger.info?.(JSON.stringify({ type, at: this.now().toISOString(), ...fields }));
  }

  /**
   * One full sweep. Safe to call directly, which is what the tests and the one-shot worker mode
   * do; overlapping calls are collapsed rather than run in parallel.
   */
  async tick() {
    if (this.running) return { skipped: 'TICK_IN_PROGRESS' };
    this.running = true;
    const startedAt = this.now();
    const summary = {
      evaluated: 0, executed: 0, denied: 0, failed: 0, outcomes: {}, payouts: [],
    };
    try {
      const autonomy = await this.autonomyStore.autonomyState();
      if (autonomy.paused) {
        // Paused means no work is created at all — not "create it and refuse later".
        this.#log('agent_worker_paused', { reason: autonomy.reason });
        return { ...summary, paused: true };
      }

      let markets;
      try {
        markets = await this.collector.listRegisteredMarkets();
      } catch (error) {
        this.#log('agent_worker_market_discovery_failed', { message: error?.message });
        return { ...summary, discoveryFailed: true };
      }

      for (const market of this.#batchFor(markets)) {
        if (this.stopped) break;
        summary.evaluated += 1;
        try {
          const result = await this.service.evaluateMarket(market);
          summary.outcomes[result.outcome] = (summary.outcomes[result.outcome] ?? 0) + 1;
          if (result.outcome === 'EXECUTED') {
            summary.executed += 1;
            summary.payouts.push({
              market: result.marketAddress,
              creator: result.creatorAddress,
              // The canonical Stage 2 figure: what the creator actually received, which is also
              // exactly what left the Agent Wallet. Never the Stage 1 gross request.
              creatorPayoutUsdc: result.payout.creatorPayoutUsdc,
              grossRequestUsdc: result.payout.grossRequestUsdc,
              settlementId: result.settlementId,
              transactionHash: result.transactionHash,
            });
            this.#log('agent_worker_payout', {
              market: result.marketAddress,
              creator: result.creatorAddress,
              creatorPayoutUsdc: result.payout.creatorPayoutUsdc,
              grossRequestUsdc: result.payout.grossRequestUsdc,
              settlementId: result.settlementId,
              epoch: result.epoch,
              executionMode: result.executionMode,
              transactionHash: result.transactionHash,
            });
          } else {
            summary.denied += 1;
          }
        } catch (error) {
          // One market's problem is not the sweep's problem.
          summary.failed += 1;
          const code = error instanceof DomainError ? error.code : 'UNEXPECTED_ERROR';
          summary.outcomes[code] = (summary.outcomes[code] ?? 0) + 1;
          this.#log('agent_worker_market_failed', { market, code, message: error?.message });
        }
      }

      this.lastTick = {
        at: startedAt.toISOString(),
        durationMs: this.now().getTime() - startedAt.getTime(),
        ...summary,
      };
      this.#log('agent_worker_tick', this.lastTick);
      return this.lastTick;
    } finally {
      this.running = false;
    }
  }

  /**
   * The markets this tick will evaluate: at most `maxMarketsPerTick`, starting where the last
   * sweep stopped and wrapping around.
   *
   * The bound itself is deliberate — an unbounded sweep would let one tick run for as long as the
   * factory is large, and ticks must not overlap. What was wrong was always taking that bound from
   * index zero: with more registered markets than the bound, the markets past it were starved
   * permanently, because every sweep re-read the same prefix.
   *
   * A worker-local cursor is enough. It needs no persistence and no schema: correctness against
   * double payment is the PostgreSQL epoch claim, not this order, so a cursor that resets on
   * restart costs a little fairness and nothing else. Wrapping never evaluates the same market
   * twice in one tick, because the batch is capped at the market count.
   */
  #batchFor(markets) {
    if (markets.length === 0) return [];
    const size = Math.min(this.maxMarketsPerTick, markets.length);
    const start = this.sweepCursor % markets.length;
    const batch = [];
    for (let offset = 0; offset < size; offset += 1) {
      batch.push(markets[(start + offset) % markets.length]);
    }
    // Advance past what this tick took, so the next one continues rather than repeats.
    this.sweepCursor = (start + size) % markets.length;
    return batch;
  }
}

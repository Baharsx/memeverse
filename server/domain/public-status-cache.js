/**
 * A tiny time-bounded cache for one public, read-only status payload.
 *
 * This exists for a single reason: assembling the public agent status costs two Circle CLI
 * subprocess reads, and a page that polls it was paying that cost on every request — sometimes
 * past the browser's own timeout, so a visitor watched "READING AGENT STATUS…" through several
 * failed polls. Serving a few-second-old copy of a *presentation* payload removes that entirely.
 *
 * The safety argument is about what this is allowed to touch. It caches the sanitized status
 * document that the public endpoint returns, and nothing else. It is constructed in the transport
 * layer and handed only to that one route, so no financial caller can reach it even by mistake:
 * payout eligibility, treasury balance, policy checks, settlement execution, and the autonomous
 * worker all call their services directly and are entirely unaware this file exists.
 *
 * Truthfulness is preserved by three rules:
 *
 *   1. the entry expires on a hard TTL, so a wallet session that dies, an operator who pauses
 *      autonomy, or a Circle outage all surface within one window rather than being pinned;
 *   2. a failed refresh is never cached — the error propagates and the next request retries;
 *   3. nothing is ever served after its expiry, so there is no "stale but better than nothing"
 *      path that could keep showing ACTIVE for an agent that has stopped being active.
 */
export class PublicStatusCache {
  constructor({ ttlMs, clock = () => Date.now() }) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('PublicStatusCache requires a positive TTL.');
    }
    // A deliberately short ceiling. This is a presentation cache; anything longer starts to be a
    // claim about the agent rather than a rendering optimization.
    if (ttlMs > 60_000) {
      throw new Error('PublicStatusCache TTL must not exceed 60 seconds.');
    }
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.entry = null;
    this.inFlight = null;
  }

  /**
   * Returns a fresh-enough payload, producing one via `load` when there is not one.
   *
   * Concurrent callers during a miss share a single in-flight load rather than each starting
   * their own — otherwise a page with several viewers would multiply exactly the subprocess work
   * this cache exists to avoid.
   */
  async read(load) {
    const now = this.clock();
    if (this.entry && now < this.entry.expiresAt) return this.entry.value;
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      try {
        const value = await load();
        // Recomputed after the await: the entry should live for a full TTL from when the data
        // actually arrived, not from when the request happened to start.
        this.entry = { value, expiresAt: this.clock() + this.ttlMs };
        return value;
      } catch (error) {
        // A failure is never cached. The next caller tries again and sees the real error.
        this.entry = null;
        throw error;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** Drops any cached copy. Used when something is known to have changed. */
  invalidate() {
    this.entry = null;
  }
}

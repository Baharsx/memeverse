/**
 * The one definition of what the autonomous agent's status word means.
 *
 * Two surfaces render this — the Agent Command Center and the Proof Center — and they drifted
 * once already: the Proof Center reported ACTIVE whenever `paused` was not literally true, which
 * meant a still-loading query, an unreachable backend, and an unconfigured or lapsed Agent Wallet
 * all displayed as a healthy agent. Absent data must never read as healthy infrastructure.
 *
 * It lives in a plain module rather than beside the components so it can be unit tested without a
 * bundler, the same reason `market-display.js` and `transaction-lifecycle.js` sit outside the JSX.
 *
 * ACTIVE requires all four: the status actually loaded, an Agent Wallet configured, that wallet
 * LIVE, and autonomy unpaused. A configured wallet whose operator has engaged the emergency stop
 * is PAUSED — deliberately stopped is a different fact from broken. Everything else is
 * UNAVAILABLE.
 */
export function autonomyDisplayState({ loaded, data } = {}) {
  if (!loaded || !data) return 'UNAVAILABLE';
  const executor = data.executor ?? {};
  if (!executor.configured) return 'UNAVAILABLE';
  if (data.paused) return 'PAUSED';
  return executor.state === 'LIVE' ? 'ACTIVE' : 'UNAVAILABLE';
}

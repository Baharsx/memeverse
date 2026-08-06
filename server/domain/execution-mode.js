/**
 * Explicit, persisted authority for moving treasury USDC.
 *
 * `MANUAL_OPERATOR` is an authenticated operator session plus a one-time, settlement-bound
 * execution authorization.
 *
 * `AUTONOMOUS_POLICY` was declared in Phase 6A.2 and failed closed until Phase 6B. It is now
 * enabled, but enabling the *mode* grants nothing on its own: an authority carrying this mode is
 * only accepted when it also carries the module-private brand minted by
 * `autonomous-authority.js`. A request body naming this mode is rejected, because JSON cannot
 * carry that brand. The two checks are independent on purpose — the mode list says what the
 * release implements, the brand says who may actually wield it.
 */
export const executionModes = Object.freeze({
  MANUAL_OPERATOR: 'MANUAL_OPERATOR',
  AUTONOMOUS_POLICY: 'AUTONOMOUS_POLICY',
});

export const enabledExecutionModes = Object.freeze([
  executionModes.MANUAL_OPERATOR,
  executionModes.AUTONOMOUS_POLICY,
]);

export function isKnownExecutionMode(mode) {
  return Object.values(executionModes).includes(mode);
}

export function isEnabledExecutionMode(mode) {
  return enabledExecutionModes.includes(mode);
}

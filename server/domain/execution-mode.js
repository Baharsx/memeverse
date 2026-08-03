/**
 * Explicit, persisted authority for moving treasury USDC.
 *
 * `MANUAL_OPERATOR` is the only mode implemented in Phase 6A.2: an authenticated operator
 * session plus a one-time, settlement-bound execution authorization. `AUTONOMOUS_POLICY` is
 * declared so Phase 6B can add policy-approved execution without a hidden bypass flag, and it
 * fails closed until that work lands.
 */
export const executionModes = Object.freeze({
  MANUAL_OPERATOR: 'MANUAL_OPERATOR',
  AUTONOMOUS_POLICY: 'AUTONOMOUS_POLICY',
});

export const enabledExecutionModes = Object.freeze([executionModes.MANUAL_OPERATOR]);

export function isKnownExecutionMode(mode) {
  return Object.values(executionModes).includes(mode);
}

export function isEnabledExecutionMode(mode) {
  return enabledExecutionModes.includes(mode);
}

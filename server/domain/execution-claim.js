/**
 * Lifecycle of a settlement's single execution submission.
 *
 * `CLAIMED` and `UNKNOWN_OUTCOME` both hold the claim: the first because a provider call is in
 * flight, the second because the provider's outcome is undetermined and nothing may retry into
 * that window until the lease expires. `SUBMITTED` and `RELEASED` hold nothing — the former
 * because a provider transaction now exists, the latter because the provider was never reached.
 */
export const executionSubmissionStatuses = Object.freeze({
  CLAIMED: 'CLAIMED',
  SUBMITTED: 'SUBMITTED',
  RELEASED: 'RELEASED',
  UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
});

const activeClaimStatuses = new Set([
  executionSubmissionStatuses.CLAIMED,
  executionSubmissionStatuses.UNKNOWN_OUTCOME,
]);

/** The submission currently holding the claim, or null when the settlement is claimable. */
export function activeExecutionClaim(record) {
  const submission = record?.executionSubmission;
  return submission && activeClaimStatuses.has(submission.status) ? submission : null;
}

/**
 * A failure that provably never reached Circle releases its claim immediately; anything that
 * might have been received is treated as an unknown outcome and keeps the claim until the lease
 * expires, so no second payout can be created while the first is undetermined.
 */
const preProviderCodes = new Set([
  'CIRCLE_NOT_CONFIGURED',
  'ARC_SETTLEMENT_CONTRACT_NOT_CONFIGURED',
  'EXECUTION_AUTHORIZATION_REQUIRED',
]);
const preProviderStatuses = new Set([400, 401, 403, 404, 422]);

export function classifyProviderFailure(error) {
  if (preProviderCodes.has(error?.code)) return 'PRE_PROVIDER';
  if (preProviderStatuses.has(error?.details?.providerStatus)) return 'PRE_PROVIDER';
  return 'UNKNOWN_OUTCOME';
}

/**
 * Lifecycle of a settlement's execution submission.
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

/**
 * Statuses under which a payout may already exist at the provider.
 *
 * This is deliberately wider than `activeClaimStatuses`: holding the claim is about who may call
 * Circle next, whereas commitment is about whether Circle may already have accepted a request.
 * `SUBMITTED` no longer blocks a claim, but it certainly means money is in motion.
 */
const committedStatuses = new Set([
  executionSubmissionStatuses.CLAIMED,
  executionSubmissionStatuses.UNKNOWN_OUTCOME,
  executionSubmissionStatuses.SUBMITTED,
]);

/** The submission currently holding the claim, or null when the settlement is claimable. */
export function activeExecutionClaim(record) {
  const submission = record?.executionSubmission;
  return submission && activeClaimStatuses.has(submission.status) ? submission : null;
}

/**
 * True once execution ownership has been established and the provider may already have accepted
 * the payout.
 *
 * This is the hinge of the quote-versus-execution lifecycle split. A quote's `expiresAt` governs
 * only the window in which execution may *begin*; once it has begun, the quote can no longer
 * invalidate the settlement, because expiry releases the treasury reservation and a released
 * reservation alongside an accepted payout would double-spend the treasury.
 *
 * A `RELEASED` submission is deliberately *not* committed: the provider was provably never
 * reached, nothing exists to protect, and ordinary quote TTL behaviour resumes.
 */
export function isExecutionCommitted(record) {
  if (record?.circle?.transactionId) return true;
  const submission = record?.executionSubmission;
  return Boolean(submission && committedStatuses.has(submission.status));
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

/**
 * Per-attempt audit evidence.
 *
 * `executionAuthorization` is the immutable root authority — the first authorization that ever
 * won a claim. Every later resume records its own entry here instead of overwriting that root,
 * so the record shows both who originated the provider operation and who approved each retry.
 */
export function executionAttemptFrom(submission) {
  return {
    attempt: submission.attempt,
    claimId: submission.claimId,
    executionMode: submission.executionMode,
    authorizationRef: submission.authorizationRef,
    operatorAddress: submission.operatorAddress,
    sessionId: submission.sessionId,
    claimedAt: submission.claimedAt,
    resumedFromClaimId: submission.resumedFromClaimId,
    status: submission.status,
    submittedAt: null,
    failedAt: null,
    failureClassification: null,
    failureCode: null,
    circleTransactionId: null,
    // Set only when this attempt's provider call resolved after another claim had taken over.
    supersededByClaimId: null,
  };
}

/** Patches one attempt in place by claim ID; an unknown claim leaves the trail untouched. */
export function markExecutionAttempt(attempts, claimId, patch) {
  if (!Array.isArray(attempts)) return attempts ?? null;
  return attempts.map((attempt) => (attempt.claimId === claimId ? { ...attempt, ...patch } : attempt));
}

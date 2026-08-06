import { randomUUID } from 'node:crypto';
import { getAddress, isAddress, keccak256, stringToHex } from 'viem';
import { DomainError } from './errors.js';
import {
  classifyProviderFailure,
  executionAttemptFrom,
  executionSubmissionStatuses,
  isExecutionCommitted,
  markExecutionAttempt,
} from './execution-claim.js';
import { ExecutionClaimHeartbeat, systemScheduler } from './execution-claim-heartbeat.js';
import { executionModes, isEnabledExecutionMode, isKnownExecutionMode } from './execution-mode.js';
import { settlementExecutionBindingHash } from './settlement-binding.js';
import { evaluateSettlementPolicy } from './policy.js';
import { settlementStates, transitionSettlement } from './settlement-state.js';
import {
  circleStateIndicatesBroadcast,
  shouldApplyCircleState,
  validateCircleState,
} from './circle-state.js';

function fingerprint(value) {
  return keccak256(stringToHex(JSON.stringify(value)));
}

export class SettlementService {
  constructor({
    store,
    policy,
    chainId,
    quoteTtlSeconds,
    circleGateway,
    arcIndexer,
    now = () => new Date(),
    id = randomUUID,
    maxWriteAttempts = 6,
    executionClaimLeaseSeconds = 120,
    executionClaimHeartbeatSeconds = 30,
    scheduler = systemScheduler,
    logger = console,
  }) {
    this.store = store;
    this.policy = policy;
    this.chainId = chainId;
    this.quoteTtlSeconds = quoteTtlSeconds;
    this.circleGateway = circleGateway;
    this.arcIndexer = arcIndexer;
    this.now = now;
    this.id = id;
    this.maxWriteAttempts = maxWriteAttempts;
    this.executionClaimLeaseSeconds = executionClaimLeaseSeconds;
    this.executionClaimHeartbeatSeconds = executionClaimHeartbeatSeconds;
    this.scheduler = scheduler;
    this.logger = logger;
  }

  normalizeRequest(input) {
    if (!isAddress(input.recipient)) {
      throw new DomainError('INVALID_RECIPIENT', 'Recipient must be a valid EVM address.', {
        details: { field: 'recipient' },
      });
    }
    return {
      recipient: getAddress(input.recipient),
      requestedAmount: input.requestedAmount,
      viralityScore: input.viralityScore,
      reference: input.reference.trim(),
    };
  }

  /**
   * Read-modify-write against the persisted row version.
   *
   * A losing writer reloads the newest record and re-evaluates its mutation, so a stale worker
   * snapshot can never overwrite newer webhook or reconciliation evidence. Retries only repeat
   * local persistence; no external Circle call is ever replayed from here.
   */
  async mutate(id, mutator) {
    for (let attempt = 0; attempt < this.maxWriteAttempts; attempt += 1) {
      const current = await this.requireRecord(id);
      const next = await mutator(current, attempt);
      if (next === undefined) return current;
      try {
        return await this.store.update(next);
      } catch (error) {
        if (error?.code !== 'SETTLEMENT_VERSION_CONFLICT') throw error;
      }
    }
    throw new DomainError(
      'SETTLEMENT_CONCURRENT_UPDATE',
      'The settlement is being updated concurrently. Read it again before retrying.',
      { status: 409 },
    );
  }

  async quote(input, idempotencyKey, context = {}) {
    const normalized = this.normalizeRequest(input);
    const agentSignals = context.agentDecision?.signals
      ? Object.fromEntries(
        Object.entries(context.agentDecision.signals).filter(([key]) => key !== 'ageSeconds'),
      )
      : null;
    const requestFingerprint = fingerprint(
      agentSignals ? { ...normalized, agentSignals } : normalized,
    );
    const existing = await this.store.getByIdempotencyKey(idempotencyKey);
    if (existing) return this.assertReplay(existing, requestFingerprint);

    const now = this.now();
    const nowIso = now.toISOString();
    const settlementId = this.id();
    const decision = evaluateSettlementPolicy(normalized, this.policy);
    const agentReasons = context.agentDecision?.reasons ?? [];
    const approved = decision.approved && agentReasons.length === 0;
    const reasons = [...decision.reasons, ...agentReasons];
    const state = approved ? settlementStates.PREPARED : settlementStates.DENIED;
    const record = {
      id: settlementId,
      idempotencyKey,
      requestFingerprint,
      chainId: this.chainId,
      chainCode: 'ARC-TESTNET',
      asset: 'USDC',
      recipient: normalized.recipient,
      viralityScore: normalized.viralityScore,
      reference: normalized.reference,
      agentDecision: context.agentDecision ?? null,
      memoId: fingerprint({ settlementId, reference: normalized.reference }),
      amount: {
        requestedUsdc: decision.requestedAmountUsdc,
        requestedUnits: decision.requestedAmountUnits,
        creatorPayoutUsdc: decision.creatorPayoutUsdc,
        creatorPayoutUnits: decision.creatorPayoutUnits,
        treasuryRetainedUsdc: decision.treasuryRetainedUsdc,
        treasuryRetainedUnits: decision.treasuryRetainedUnits,
      },
      policy: {
        approved,
        reasons,
        maxSpendUsdc: this.policy.maxSpendUsdc,
        minViralityScore: this.policy.minViralityScore,
        creatorShareBps: this.policy.creatorShareBps,
      },
      state,
      broadcast: false,
      transactionHash: null,
      executionPlan: null,
      executionAuthorization: null,
      executionSubmission: null,
      executionAttempts: [],
      circle: null,
      expiresAt: approved
        ? new Date(now.getTime() + this.quoteTtlSeconds * 1000).toISOString()
        : null,
      createdAt: nowIso,
      updatedAt: nowIso,
      history: [{ state, at: nowIso, reason: approved ? 'POLICY_APPROVED' : 'POLICY_DENIED' }],
    };

    if (approved) await this.releaseExpiredReservations();
    const treasuryAvailableUnits = approved && this.circleGateway?.treasuryAvailableUnits
      ? await this.circleGateway.treasuryAvailableUnits()
      : undefined;
    const result = await this.store.createIfAbsent(record, {
      treasuryAvailableUnits,
      agentDailyCapUnits: approved ? context.agentDailyCapUnits : undefined,
    });
    if (!result.created) return this.assertReplay(result.record, requestFingerprint);
    return { record: result.record, replayed: false };
  }

  assertReplay(record, requestFingerprint) {
    if (record.requestFingerprint !== requestFingerprint) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already used with a different request.',
        { status: 409 },
      );
    }
    return { record, replayed: true };
  }

  async prepare(id) {
    let record = await this.requireRecord(id);
    record = await this.expireIfNeeded(record);

    if (record.state === settlementStates.AWAITING_SIGNATURE) return record;
    if (record.state !== settlementStates.PREPARED) {
      throw new DomainError(
        'SETTLEMENT_NOT_PREPARABLE',
        `Settlement in ${record.state} state cannot be prepared for signing.`,
        { status: 409, details: { currentState: record.state } },
      );
    }

    return this.mutate(id, (current) => {
      if (current.state === settlementStates.AWAITING_SIGNATURE) return undefined;
      if (current.state !== settlementStates.PREPARED) {
        throw new DomainError(
          'SETTLEMENT_NOT_PREPARABLE',
          `Settlement in ${current.state} state cannot be prepared for signing.`,
          { status: 409, details: { currentState: current.state } },
        );
      }
      const nowIso = this.now().toISOString();
      const transitioned = transitionSettlement(
        current,
        settlementStates.AWAITING_SIGNATURE,
        nowIso,
        { reason: 'EXECUTION_PLAN_CREATED' },
      );
      transitioned.executionPlan = this.circleGateway?.createExecutionPlan
        ? this.circleGateway.createExecutionPlan(current)
        : {
          provider: 'CIRCLE_DEVELOPER_CONTROLLED_WALLET',
          chain: 'ARC-TESTNET',
          asset: 'USDC',
          recipient: current.recipient,
          amountUsdc: current.amount.creatorPayoutUsdc,
          memoId: current.memoId,
          requiresSigning: true,
          broadcast: false,
        };
      return transitioned;
    });
  }

  /**
   * Rejects any execution that is not carrying an explicit, enabled authority. The domain never
   * infers permission from the caller; the transport must present a resolved authorization.
   */
  requireExecutionAuthority(authorization) {
    if (!authorization || !isKnownExecutionMode(authorization.mode)) {
      throw new DomainError(
        'EXECUTION_AUTHORIZATION_REQUIRED',
        'Settlement execution requires an explicit, settlement-bound authorization.',
        { status: 403 },
      );
    }
    if (!isEnabledExecutionMode(authorization.mode)) {
      throw new DomainError(
        'EXECUTION_MODE_NOT_ENABLED',
        `Execution mode ${authorization.mode} is not implemented in this release.`,
        { status: 501, details: { executionMode: authorization.mode } },
      );
    }
    if (authorization.mode === executionModes.MANUAL_OPERATOR
      && (!authorization.operatorAddress || !authorization.authorizationRef)) {
      throw new DomainError(
        'EXECUTION_AUTHORIZATION_REQUIRED',
        'Manual operator execution requires an authenticated operator and a consumed authorization.',
        { status: 403 },
      );
    }
    return {
      mode: authorization.mode,
      operatorAddress: authorization.operatorAddress ?? null,
      sessionId: authorization.sessionId ?? null,
      authorizationRef: authorization.authorizationRef,
      bindingHash: authorization.bindingHash ?? null,
      authorizedAt: authorization.authorizedAt ?? this.now().toISOString(),
    };
  }

  notExecutable(state) {
    return new DomainError(
      'SETTLEMENT_NOT_EXECUTABLE',
      `Settlement in ${state} state cannot be sent to Circle.`,
      { status: 409, details: { currentState: state } },
    );
  }

  /**
   * Re-checks the approved payload against the settlement as it stands right now. The transport
   * already validated the binding when it consumed the authorization; repeating it inside the
   * claim closes the window between those two steps.
   */
  assertExecutionBinding(record, authority) {
    if (authority.mode !== executionModes.MANUAL_OPERATOR) return;
    const expected = settlementExecutionBindingHash(record);
    if (authority.bindingHash !== expected) {
      throw new DomainError(
        'EXECUTION_BINDING_MISMATCH',
        'The settlement changed after it was authorized. Review and authorize it again.',
        { status: 409 },
      );
    }
  }

  buildExecutionClaim(current, authority, nowIso) {
    const previous = current.executionSubmission ?? null;
    const resuming = Boolean(previous?.claimId
      && previous.status !== executionSubmissionStatuses.RELEASED);
    return {
      status: executionSubmissionStatuses.CLAIMED,
      claimId: this.id(),
      attempt: (previous?.attempt ?? 0) + 1,
      executionMode: authority.mode,
      // The authority behind *this* attempt. The root `executionAuthorization` keeps the first
      // one forever, so a recovery is attributable without rewriting who originated the payout.
      authorizationRef: authority.authorizationRef,
      initialAuthorizationRef: current.executionAuthorization?.authorizationRef
        ?? authority.authorizationRef,
      bindingHash: authority.bindingHash,
      operatorAddress: authority.operatorAddress,
      sessionId: authority.sessionId,
      // Derived from the settlement itself, so a resume can never mint a second provider
      // operation identity and can never create a second payout.
      providerOperationKey: current.id,
      claimedAt: nowIso,
      leaseExpiresAt: new Date(
        new Date(nowIso).getTime() + this.executionClaimLeaseSeconds * 1000,
      ).toISOString(),
      resumedFromClaimId: resuming ? previous.claimId : null,
      submittedAt: null,
      failedAt: null,
      lastError: null,
    };
  }

  /**
   * The durable, multi-process gate in front of Circle. Exactly one caller leaves this method
   * holding a claim; every other caller is rejected or redirected to reconciliation, and the
   * winner's authority is never overwritten while its claim is live.
   */
  async claimExecution(id, authorization) {
    const authority = this.requireExecutionAuthority(authorization);
    for (let attempt = 0; attempt < this.maxWriteAttempts; attempt += 1) {
      const current = await this.requireRecord(id);
      if (current.circle?.transactionId) return { outcome: 'ALREADY_SUBMITTED', record: current };
      if (current.state !== settlementStates.AWAITING_SIGNATURE) {
        throw this.notExecutable(current.state);
      }
      this.assertExecutionBinding(current, authority);

      const nowIso = this.now().toISOString();
      const submission = this.buildExecutionClaim(current, authority, nowIso);
      const claimed = {
        ...current,
        // Written once, by the first claim that ever wins, and immutable from then on. A later
        // recovery is recorded as its own attempt rather than replacing the audit root.
        executionAuthorization: current.executionAuthorization ?? authority,
        executionSubmission: submission,
        executionAttempts: [
          ...(current.executionAttempts ?? []),
          executionAttemptFrom(submission),
        ],
        updatedAt: nowIso,
        history: [...current.history, {
          event: 'EXECUTION',
          state: current.state,
          at: nowIso,
          reason: submission.resumedFromClaimId ? 'EXECUTION_CLAIM_RESUMED' : 'EXECUTION_CLAIMED',
          claimId: submission.claimId,
          attempt: submission.attempt,
          executionMode: authority.mode,
          authorizationRef: authority.authorizationRef,
          operatorAddress: authority.operatorAddress,
        }],
      };
      const result = await this.store.claimExecution({
        record: claimed,
        expectedVersion: current.version ?? 0,
        nowIso,
      });

      if (result.outcome === 'CLAIMED') return result;
      if (result.outcome === 'ALREADY_SUBMITTED') {
        return { outcome: 'ALREADY_SUBMITTED', record: await this.requireRecord(id) };
      }
      if (result.outcome === 'ALREADY_CLAIMED') {
        throw new DomainError(
          'EXECUTION_ALREADY_CLAIMED',
          'Another authorized execution of this settlement is already in progress.',
          { status: 409, details: { claimExpiresAt: result.current?.claimUntil ?? null } },
        );
      }
      if (result.outcome === 'NOT_EXECUTABLE') throw this.notExecutable(result.current.state);
      if (result.outcome === 'NOT_FOUND') {
        throw new DomainError('SETTLEMENT_NOT_FOUND', 'Settlement was not found.', { status: 404 });
      }
      // VERSION_CONFLICT: the row moved under us, so re-read and re-evaluate before retrying.
    }
    throw new DomainError(
      'SETTLEMENT_CONCURRENT_UPDATE',
      'The settlement is being updated concurrently. Read it again before retrying.',
      { status: 409 },
    );
  }

  async execute(id, authorization) {
    const authority = this.requireExecutionAuthority(authorization);
    let record = await this.requireRecord(id);
    record = await this.expireIfNeeded(record);
    if (record.circle?.transactionId) return this.reconcile(id);
    if (record.state !== settlementStates.AWAITING_SIGNATURE) {
      throw this.notExecutable(record.state);
    }
    if (!this.circleGateway) {
      throw new DomainError('CIRCLE_NOT_CONFIGURED', 'Circle wallet gateway is unavailable.', {
        status: 503,
      });
    }

    const claim = await this.claimExecution(id, authority);
    if (claim.outcome === 'ALREADY_SUBMITTED') return this.reconcile(id);
    return this.submitClaimedExecution(claim.record);
  }

  /** A lease renewal loop bound to one claim, live only while that claim's provider call is. */
  startExecutionHeartbeat(settlementId, claimId) {
    return new ExecutionClaimHeartbeat({
      store: this.store,
      settlementId,
      claimId,
      leaseSeconds: this.executionClaimLeaseSeconds,
      intervalSeconds: this.executionClaimHeartbeatSeconds,
      now: this.now,
      scheduler: this.scheduler,
      logger: this.logger,
    }).start();
  }

  /**
   * Only the claim holder reaches Circle, and it does so outside any database transaction.
   * A failure is classified before it is persisted so an undetermined outcome keeps its claim
   * while a failure that never reached the provider frees the settlement immediately.
   *
   * The claim's lease is renewed for as long as this call is outstanding, so a slow provider
   * cannot hand the settlement to a second caller while the first request is still alive. The
   * heartbeat always stops before the result is persisted — on success, on failure, and when
   * ownership can no longer be proven.
   */
  async submitClaimedExecution(record) {
    const { claimId } = record.executionSubmission;
    const heartbeat = this.startExecutionHeartbeat(record.id, claimId);
    let transaction;
    try {
      try {
        transaction = await this.circleGateway.executeSettlement(record);
      } finally {
        await heartbeat.stop();
      }
    } catch (error) {
      await this.recordSubmissionFailure(record.id, claimId, error);
      throw error;
    }
    const submittedAt = this.now().toISOString();
    return this.applyCircleTransaction(record.id, transaction, 'CIRCLE_TRANSFER_CREATED', {
      decorate: (merged, current) => {
        // Ownership may have moved on while the call was open. The transaction ID is persisted
        // either way — losing it would be far worse than an ambiguous claim — but a superseded
        // claimant never rewrites the current attempt's status or authority.
        if (current.executionSubmission?.claimId !== claimId) {
          return {
            ...merged,
            executionAttempts: markExecutionAttempt(merged.executionAttempts, claimId, {
              status: executionSubmissionStatuses.SUBMITTED,
              submittedAt,
              circleTransactionId: transaction.id,
            }),
            history: [...merged.history, {
              event: 'EXECUTION',
              state: merged.state,
              at: submittedAt,
              reason: 'EXECUTION_SUBMITTED_BY_SUPERSEDED_CLAIM',
              claimId,
              circleTransactionId: transaction.id,
            }],
          };
        }
        return {
          ...merged,
          executionSubmission: {
            ...merged.executionSubmission,
            status: executionSubmissionStatuses.SUBMITTED,
            submittedAt,
            leaseExpiresAt: null,
            lastError: null,
          },
          executionAttempts: markExecutionAttempt(merged.executionAttempts, claimId, {
            status: executionSubmissionStatuses.SUBMITTED,
            submittedAt,
            circleTransactionId: transaction.id,
          }),
          history: [...merged.history, {
            event: 'EXECUTION',
            state: merged.state,
            at: submittedAt,
            reason: 'EXECUTION_SUBMITTED',
            claimId,
            circleTransactionId: transaction.id,
          }],
        };
      },
    });
  }

  async recordSubmissionFailure(id, claimId, error) {
    const classification = classifyProviderFailure(error);
    const released = classification === 'PRE_PROVIDER';
    await this.mutate(id, (current) => {
      // Ownership may already have moved on; a stale failure never rewrites another claim.
      if (current.executionSubmission?.claimId !== claimId) return undefined;
      const nowIso = this.now().toISOString();
      const status = released
        ? executionSubmissionStatuses.RELEASED
        : executionSubmissionStatuses.UNKNOWN_OUTCOME;
      return {
        ...current,
        executionSubmission: {
          ...current.executionSubmission,
          status,
          leaseExpiresAt: released ? null : current.executionSubmission.leaseExpiresAt,
          failedAt: nowIso,
          lastError: {
            code: error?.code ?? 'CIRCLE_REQUEST_FAILED',
            status: error?.status ?? null,
            classification,
          },
        },
        executionAttempts: markExecutionAttempt(current.executionAttempts, claimId, {
          status,
          failedAt: nowIso,
          failureClassification: classification,
          failureCode: error?.code ?? 'CIRCLE_REQUEST_FAILED',
        }),
        updatedAt: nowIso,
        history: [...current.history, {
          event: 'EXECUTION',
          state: current.state,
          at: nowIso,
          reason: 'EXECUTION_SUBMISSION_FAILED',
          claimId,
          classification,
          code: error?.code ?? 'CIRCLE_REQUEST_FAILED',
        }],
      };
    }).catch(() => undefined);
  }

  async reconcile(id) {
    const record = await this.requireRecord(id);
    if (!record.circle?.transactionId) {
      throw new DomainError(
        'CIRCLE_TRANSACTION_NOT_CREATED',
        'Settlement has not been submitted to Circle.',
        { status: 409 },
      );
    }
    if (!this.circleGateway) {
      throw new DomainError('CIRCLE_NOT_CONFIGURED', 'Circle wallet gateway is unavailable.', {
        status: 503,
      });
    }
    const transaction = await this.circleGateway.getTransaction(record.circle.transactionId);
    return this.applyCircleTransaction(id, transaction, 'CIRCLE_STATUS_RECONCILED');
  }

  async applyCircleNotification(transaction) {
    const record = await this.store.getByCircleTransactionId(transaction.id);
    if (!record) return { matched: false, transactionId: transaction.id };
    const updated = await this.applyCircleTransaction(record.id, transaction, 'CIRCLE_WEBHOOK');
    return { matched: true, settlementId: updated.id, state: updated.state };
  }

  /**
   * Merges provider evidence monotonically. Circle state may only advance, an advanced
   * application state cannot regress, and transaction hashes, wallet identity, and failure
   * details are preserved when an older snapshot arrives after a newer one.
   */
  mergeCircleTransaction(record, transaction, reason) {
    if (transaction.blockchain && transaction.blockchain !== 'ARC-TESTNET') {
      throw new DomainError('CIRCLE_CHAIN_MISMATCH', 'Circle transaction is not on Arc Testnet.', {
        status: 502,
      });
    }
    if (record.circle?.transactionId && record.circle.transactionId !== transaction.id) {
      throw new DomainError('CIRCLE_TRANSACTION_MISMATCH', 'Circle transaction ID does not match.', {
        status: 502,
      });
    }
    const providerTarget = transaction.contractAddress ?? transaction.destinationAddress;
    if (providerTarget && record.executionPlan?.memoContract
      && providerTarget.toLowerCase() !== record.executionPlan.memoContract.toLowerCase()) {
      throw new DomainError('CIRCLE_DESTINATION_MISMATCH', 'Circle transaction Memo target mismatch.', {
        status: 502,
      });
    }

    validateCircleState(transaction.state);
    const nowIso = this.now().toISOString();
    const currentCircleState = record.circle?.state;
    const circleAdvances = !currentCircleState
      || shouldApplyCircleState(currentCircleState, transaction.state);
    // Circle COMPLETE means provider processing is complete. The application only becomes
    // COMPLETE after the Arc receipt and all expected events are verified.
    const applicationState = transaction.state === settlementStates.COMPLETE
      ? settlementStates.CONFIRMED
      : transaction.state;
    const shouldTransition = circleAdvances
      && applicationState !== record.state
      && shouldApplyCircleState(record.state, applicationState);

    let updated = shouldTransition
      ? transitionSettlement(record, applicationState, nowIso, { reason })
      : { ...record, updatedAt: nowIso };
    const transactionHash = circleAdvances
      ? transaction.txHash ?? record.transactionHash ?? null
      : record.transactionHash ?? transaction.txHash ?? null;
    const broadcast = Boolean(
      record.broadcast || circleStateIndicatesBroadcast(transaction.state, transactionHash),
    );
    return {
      ...updated,
      broadcast,
      transactionHash,
      executionPlan: updated.executionPlan ? {
        ...updated.executionPlan,
        requiresSigning: false,
        broadcast,
      } : null,
      circle: {
        transactionId: transaction.id,
        state: circleAdvances ? transaction.state : currentCircleState,
        walletId: transaction.walletId ?? record.circle?.walletId ?? null,
        sourceAddress: transaction.sourceAddress ?? record.circle?.sourceAddress ?? null,
        lastSyncedAt: nowIso,
        errorReason: circleAdvances
          ? transaction.errorReason ?? null
          : record.circle?.errorReason ?? null,
        errorDetails: circleAdvances
          ? transaction.errorDetails ?? null
          : record.circle?.errorDetails ?? null,
      },
    };
  }

  async applyCircleTransaction(id, transaction, reason, { decorate } = {}) {
    const updated = await this.mutate(id, (current) => {
      const merged = this.mergeCircleTransaction(current, transaction, reason);
      return decorate ? decorate(merged, current) : merged;
    });
    return this.verifyOnchainIfReady(updated);
  }

  async verifyOnchainIfReady(record) {
    if (!this.arcIndexer || !record.transactionHash
      || !['CONFIRMED', 'COMPLETE'].includes(record.circle?.state)) return record;
    if (record.state === settlementStates.COMPLETE
      && record.reconciliation?.status === 'VERIFIED') return record;

    const reconciliation = await this.arcIndexer.verify(record);
    return this.mutate(record.id, (current) => {
      // A verified reconciliation is final evidence; a later weaker result never erases it.
      if (current.reconciliation?.status === 'VERIFIED' && reconciliation.status !== 'VERIFIED') {
        return undefined;
      }
      let updated = {
        ...current,
        reconciliation,
        updatedAt: this.now().toISOString(),
      };
      if (reconciliation.status === 'VERIFIED' && updated.state === settlementStates.CONFIRMED) {
        updated = transitionSettlement(updated, settlementStates.COMPLETE, updated.updatedAt, {
          reason: 'ARC_EVENTS_VERIFIED',
          blockNumber: reconciliation.blockNumber,
        });
      } else if (reconciliation.status === 'MISMATCH'
        && ![settlementStates.FAILED, settlementStates.COMPLETE].includes(updated.state)) {
        updated = transitionSettlement(updated, settlementStates.FAILED, updated.updatedAt, {
          reason: 'ARC_EVENT_MISMATCH',
          failures: reconciliation.failures,
        });
      }
      return updated;
    });
  }

  async get(id) {
    return this.expireIfNeeded(await this.requireRecord(id));
  }

  async list() {
    const records = await this.store.list();
    return Promise.all(records.map((record) => this.expireIfNeeded(record)));
  }

  async releaseExpiredReservations() {
    const records = await this.store.list();
    for (const record of records) await this.expireIfNeeded(record);
  }

  async requireRecord(id) {
    const record = await this.store.get(id);
    if (!record) {
      throw new DomainError('SETTLEMENT_NOT_FOUND', 'Settlement was not found.', { status: 404 });
    }
    return record;
  }

  /**
   * A quote's TTL bounds when execution may *begin*, not how long it may take.
   *
   * Once a claim has been won, `expiresAt` can no longer invalidate the settlement: expiry
   * releases the treasury reservation, and releasing capacity while Circle may already have
   * accepted the payout would let the treasury be committed twice. Expiry therefore resumes only
   * for a submission that provably never reached the provider and was released.
   */
  isExpirable(record) {
    return Boolean(
      record.expiresAt
      && [settlementStates.PREPARED, settlementStates.AWAITING_SIGNATURE].includes(record.state)
      && !isExecutionCommitted(record)
      && this.now().getTime() >= new Date(record.expiresAt).getTime(),
    );
  }

  async expireIfNeeded(record) {
    if (!this.isExpirable(record)) return record;
    return this.mutate(record.id, (current) => {
      if (!this.isExpirable(current)) return undefined;
      return transitionSettlement(
        current,
        settlementStates.EXPIRED,
        this.now().toISOString(),
        { reason: 'QUOTE_TTL_ELAPSED' },
      );
    });
  }
}

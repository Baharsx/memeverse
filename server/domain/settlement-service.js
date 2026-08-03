import { randomUUID } from 'node:crypto';
import { getAddress, isAddress, keccak256, stringToHex } from 'viem';
import { DomainError } from './errors.js';
import { executionModes, isEnabledExecutionMode, isKnownExecutionMode } from './execution-mode.js';
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

  async execute(id, authorization) {
    const authority = this.requireExecutionAuthority(authorization);
    let record = await this.requireRecord(id);
    record = await this.expireIfNeeded(record);
    if (record.circle?.transactionId) return this.reconcile(id);
    if (record.state !== settlementStates.AWAITING_SIGNATURE) {
      throw new DomainError(
        'SETTLEMENT_NOT_EXECUTABLE',
        `Settlement in ${record.state} state cannot be sent to Circle.`,
        { status: 409, details: { currentState: record.state } },
      );
    }
    if (!this.circleGateway) {
      throw new DomainError('CIRCLE_NOT_CONFIGURED', 'Circle wallet gateway is unavailable.', {
        status: 503,
      });
    }

    // Persisted before the external call so the authority behind a broadcast survives a
    // provider error, a crash, or a later dispute.
    record = await this.mutate(id, (current) => {
      if (current.circle?.transactionId) return undefined;
      if (current.state !== settlementStates.AWAITING_SIGNATURE) {
        throw new DomainError(
          'SETTLEMENT_NOT_EXECUTABLE',
          `Settlement in ${current.state} state cannot be sent to Circle.`,
          { status: 409, details: { currentState: current.state } },
        );
      }
      return {
        ...current,
        executionAuthorization: authority,
        updatedAt: this.now().toISOString(),
      };
    });
    if (record.circle?.transactionId) return this.reconcile(id);

    const transaction = await this.circleGateway.executeSettlement(record);
    return this.applyCircleTransaction(id, transaction, 'CIRCLE_TRANSFER_CREATED');
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

  async applyCircleTransaction(id, transaction, reason) {
    const updated = await this.mutate(id, (current) => (
      this.mergeCircleTransaction(current, transaction, reason)
    ));
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

  isExpirable(record) {
    return Boolean(
      record.expiresAt
      && [settlementStates.PREPARED, settlementStates.AWAITING_SIGNATURE].includes(record.state)
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

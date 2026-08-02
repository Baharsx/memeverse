import { randomUUID } from 'node:crypto';
import { getAddress, isAddress, keccak256, stringToHex } from 'viem';
import { DomainError } from './errors.js';
import { evaluateSettlementPolicy } from './policy.js';
import { settlementStates, transitionSettlement } from './settlement-state.js';

function fingerprint(value) {
  return keccak256(stringToHex(JSON.stringify(value)));
}

export class SettlementService {
  constructor({ store, policy, chainId, quoteTtlSeconds, now = () => new Date(), id = randomUUID }) {
    this.store = store;
    this.policy = policy;
    this.chainId = chainId;
    this.quoteTtlSeconds = quoteTtlSeconds;
    this.now = now;
    this.id = id;
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

  async quote(input, idempotencyKey) {
    const normalized = this.normalizeRequest(input);
    const requestFingerprint = fingerprint(normalized);
    const existing = await this.store.getByIdempotencyKey(idempotencyKey);
    if (existing) return this.assertReplay(existing, requestFingerprint);

    const now = this.now();
    const nowIso = now.toISOString();
    const settlementId = this.id();
    const decision = evaluateSettlementPolicy(normalized, this.policy);
    const state = decision.approved ? settlementStates.PREPARED : settlementStates.DENIED;
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
        approved: decision.approved,
        reasons: decision.reasons,
        maxSpendUsdc: this.policy.maxSpendUsdc,
        minViralityScore: this.policy.minViralityScore,
        creatorShareBps: this.policy.creatorShareBps,
      },
      state,
      broadcast: false,
      transactionHash: null,
      executionPlan: null,
      expiresAt: decision.approved
        ? new Date(now.getTime() + this.quoteTtlSeconds * 1000).toISOString()
        : null,
      createdAt: nowIso,
      updatedAt: nowIso,
      history: [{ state, at: nowIso, reason: decision.approved ? 'POLICY_APPROVED' : 'POLICY_DENIED' }],
    };

    const result = await this.store.createIfAbsent(record);
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

    const nowIso = this.now().toISOString();
    const transitioned = transitionSettlement(record, settlementStates.AWAITING_SIGNATURE, nowIso, {
      reason: 'EXECUTION_PLAN_CREATED',
    });
    transitioned.executionPlan = {
      provider: 'CIRCLE_AGENT_WALLET_PHASE_2',
      chain: 'ARC-TESTNET',
      asset: 'USDC',
      recipient: record.recipient,
      amountUsdc: record.amount.creatorPayoutUsdc,
      memoId: record.memoId,
      requiresSigning: true,
      broadcast: false,
    };
    return this.store.update(transitioned);
  }

  async get(id) {
    return this.expireIfNeeded(await this.requireRecord(id));
  }

  async list() {
    const records = await this.store.list();
    return Promise.all(records.map((record) => this.expireIfNeeded(record)));
  }

  async requireRecord(id) {
    const record = await this.store.get(id);
    if (!record) {
      throw new DomainError('SETTLEMENT_NOT_FOUND', 'Settlement was not found.', { status: 404 });
    }
    return record;
  }

  async expireIfNeeded(record) {
    if (
      record.expiresAt
      && [settlementStates.PREPARED, settlementStates.AWAITING_SIGNATURE].includes(record.state)
      && this.now().getTime() >= new Date(record.expiresAt).getTime()
    ) {
      const expired = transitionSettlement(
        record,
        settlementStates.EXPIRED,
        this.now().toISOString(),
        { reason: 'QUOTE_TTL_ELAPSED' },
      );
      return this.store.update(expired);
    }
    return record;
  }
}

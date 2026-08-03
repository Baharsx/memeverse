import { getAddress } from 'viem';
import { evaluateAgentSignals } from './agent-policy.js';
import { DomainError } from './errors.js';
import { assertTrustedProvenance, signalProvenance } from './signal-provenance.js';

/**
 * Agent decisions always carry server-assigned provenance.
 *
 * `decideOperator` is the only entry point reachable from HTTP. It stamps `OPERATOR_INPUT`,
 * binds the observation timestamp to the server clock, and records the authenticated operator.
 * `decideTrusted` is the internal seam Phase 6B will call from an indexer or analytics worker;
 * it is not wired to any route and rejects any provenance a browser could claim.
 */
export class AgentDecisionService {
  constructor({ settlementService, arcRpc, circleGateway, policy, now = () => new Date() }) {
    this.settlementService = settlementService;
    this.arcRpc = arcRpc;
    this.circleGateway = circleGateway;
    this.policy = policy;
    this.now = now;
  }

  async decideOperator({ input, operator, idempotencyKey }) {
    if (!operator?.address) {
      throw new DomainError('OPERATOR_AUTH_REQUIRED', 'An authenticated operator is required.', {
        status: 401,
      });
    }
    return this.evaluate({
      input,
      idempotencyKey,
      provenance: signalProvenance.OPERATOR_INPUT,
      // The operator enters values live, so the server clock is the observation time. No client
      // supplied timestamp can widen the evidence freshness window.
      observedAt: this.now().toISOString(),
      evidence: {
        suppliedBy: 'AUTHENTICATED_OPERATOR',
        operatorAddress: getAddress(operator.address),
        operatorSessionId: operator.sessionId ?? null,
        observedAtSource: 'SERVER_CLOCK',
      },
    });
  }

  async decideTrusted({ provenance, input, observedAt, collector, idempotencyKey }) {
    assertTrustedProvenance(provenance);
    return this.evaluate({
      input,
      idempotencyKey,
      provenance,
      observedAt: observedAt ?? this.now().toISOString(),
      evidence: {
        suppliedBy: 'INTERNAL_COLLECTOR',
        collector: collector ?? null,
        observedAtSource: observedAt ? 'COLLECTOR_TIMESTAMP' : 'SERVER_CLOCK',
      },
    });
  }

  async evaluate({ input, idempotencyKey, provenance, observedAt, evidence }) {
    const [arc, circle] = await Promise.all([
      this.arcRpc.health(),
      this.circleGateway?.readiness() ?? Promise.resolve({ configured: false }),
    ]);
    const agentDecision = evaluateAgentSignals(
      { ...input.signals, observedAt, provenance },
      this.policy,
      { now: this.now(), arc, circle, evidence },
    );
    const quote = await this.settlementService.quote({
      recipient: input.recipient,
      requestedAmount: input.requestedAmount,
      viralityScore: agentDecision.confidenceAdjustedScore,
      reference: input.reference,
    }, idempotencyKey, {
      agentDecision,
      agentDailyCapUnits: this.policy.dailySpendUnits,
    });
    if (!quote.record.policy.approved) return quote;
    return {
      record: await this.settlementService.prepare(quote.record.id),
      replayed: quote.replayed,
    };
  }
}

import { evaluateAgentSignals } from './agent-policy.js';

export class AgentDecisionService {
  constructor({ settlementService, arcRpc, circleGateway, policy, now = () => new Date() }) {
    this.settlementService = settlementService;
    this.arcRpc = arcRpc;
    this.circleGateway = circleGateway;
    this.policy = policy;
    this.now = now;
  }

  async decide(input, idempotencyKey) {
    const [arc, circle] = await Promise.all([
      this.arcRpc.health(),
      this.circleGateway?.readiness() ?? Promise.resolve({ configured: false }),
    ]);
    const agentDecision = evaluateAgentSignals(input.signals, this.policy, {
      now: this.now(),
      arc,
      circle,
    });
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

import { getAddress } from 'viem';
import {
  applySpendCaps, derivePayoutUnits, grossForCreatorPayout, payoutEpoch,
} from './agent-payout.js';
import { evaluateAgentSignals } from './agent-policy.js';
import {
  assertAutonomousAuthorityFresh, mintAutonomousAuthority,
} from './autonomous-authority.js';
import { DomainError } from './errors.js';
import { formatUsdc } from './money.js';
import { requireAutonomyActive } from '../repositories/agent-autonomy-store.js';
import { signalProvenance } from './signal-provenance.js';

/**
 * The autonomous creator-settlement path, end to end and with no human in it.
 *
 * Real Arc evidence -> deterministic metrics -> policy -> bounded payout -> durable epoch claim
 * -> quote -> prepare -> internally minted authority -> the existing Stage 1 execution claim.
 *
 * What makes this safe is what it refuses to accept. The recipient is read from the market
 * contract, the amount is derived from the score, the observation time comes from the anchor
 * block, and the authority is minted in-process. None of those can be supplied by a caller,
 * because no caller reaches this class.
 */

export const AUTONOMOUS_POLICY_VERSION = 'AGENT_AUTONOMOUS_POLICY_V1';

/** Start of the current UTC day, the window every daily cap is measured over. */
function startOfUtcDay(now) {
  return new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  )).toISOString();
}

export class AutonomousAgentService {
  constructor({
    collector,
    autonomyStore,
    settlementService,
    agentPolicy,
    payoutPolicy,
    arcRpc,
    circleGateway,
    cooldownSeconds,
    decisionTtlSeconds,
    workerId,
    creatorShareBps,
    now = () => new Date(),
    logger = console,
  }) {
    this.collector = collector;
    this.autonomyStore = autonomyStore;
    this.settlementService = settlementService;
    this.agentPolicy = agentPolicy;
    this.payoutPolicy = payoutPolicy;
    this.arcRpc = arcRpc;
    this.circleGateway = circleGateway;
    this.cooldownSeconds = cooldownSeconds;
    this.decisionTtlSeconds = decisionTtlSeconds;
    this.workerId = workerId;
    // Needed to turn a decided creator payout into the gross settlement amount that delivers it.
    this.creatorShareBps = creatorShareBps;
    this.now = now;
    this.logger = logger;
  }

  /**
   * Evaluates one registered market and, if everything passes, pays its creator.
   *
   * Returns a structured outcome rather than throwing for ordinary denials: "this market is not
   * eligible" is a normal result the UI must be able to show, not an error.
   */
  async evaluateMarket(marketAddress) {
    // 1. Autonomy must be on. Checked here, and again immediately before the claim.
    const autonomy = await this.autonomyStore.autonomyState();
    if (autonomy.paused) {
      return this.#denied('AUTONOMY_PAUSED', [{
        code: 'AUTONOMY_PAUSED',
        message: autonomy.reason ?? 'Autonomous settlement is paused.',
      }], { marketAddress });
    }

    // 2. Real confirmed Arc evidence. The creator and the observation time come from here.
    const evidence = await this.collector.collect(marketAddress);

    // 3. Deterministic policy over those signals.
    const [arc, circle] = await Promise.all([
      this.arcRpc.health(),
      this.circleGateway?.readiness() ?? Promise.resolve({ configured: false }),
    ]);
    const decision = evaluateAgentSignals(
      {
        ...evidence.metrics.signals,
        observedAt: evidence.observedAt,
        provenance: signalProvenance.ONCHAIN_INDEXER,
      },
      this.agentPolicy,
      {
        now: this.now(),
        arc,
        circle,
        evidence: {
          suppliedBy: 'INTERNAL_COLLECTOR',
          collector: evidence.collector,
          observedAtSource: 'ARC_ANCHOR_BLOCK',
          chainId: evidence.chainId,
          factoryAddress: evidence.factoryAddress,
          marketAddress: evidence.marketAddress,
          creatorAddress: evidence.creatorAddress,
          fromBlock: evidence.fromBlock,
          toBlock: evidence.toBlock,
          anchorBlockHash: evidence.anchorBlockHash,
          evidenceDigest: evidence.evidenceDigest,
          metricVersion: evidence.metrics.metricVersion,
          policyVersion: AUTONOMOUS_POLICY_VERSION,
          raw: evidence.metrics.raw,
          riskReasons: evidence.metrics.riskReasons,
        },
      },
    );
    if (!decision.approved) {
      return this.#denied('POLICY_DENIED', decision.reasons, { marketAddress, evidence, decision });
    }

    // 4. Derive the amount from the score. Nothing external contributes to this number.
    const derived = derivePayoutUnits(decision.confidenceAdjustedScore, this.payoutPolicy);
    if (derived === 0n) {
      return this.#denied('SCORE_BELOW_PAYOUT_FLOOR', [{
        code: 'SCORE_BELOW_PAYOUT_FLOOR',
        message: `Score ${decision.confidenceAdjustedScore} is below the payout floor ${this.payoutPolicy.scoreFloor}.`,
      }], { marketAddress, evidence, decision });
    }

    const sinceIso = startOfUtcDay(this.now());
    const spent = await this.autonomyStore.spentTodayUnits({
      marketAddress: evidence.marketAddress, sinceIso,
    });
    const capped = applySpendCaps(derived, this.payoutPolicy, {
      marketSpentTodayUnits: spent.marketUnits,
      globalSpentTodayUnits: spent.globalUnits,
    });
    if (!capped.approved) {
      return this.#denied('SPEND_CAP_EXCEEDED', capped.reasons, {
        marketAddress, evidence, decision, capped,
      });
    }

    // 5. Cooldown. The epoch is derived from chain time, so every worker computes the same one.
    const epoch = payoutEpoch(evidence.observedAtSeconds, this.cooldownSeconds);
    const claim = await this.autonomyStore.claimPayoutEpoch({
      marketAddress: evidence.marketAddress,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
      epoch,
      evidenceDigest: evidence.evidenceDigest,
      creatorAddress: evidence.creatorAddress,
      claimedBy: this.workerId,
    });
    if (claim.outcome === 'ALREADY_CLAIMED') {
      // Either a peer worker owns this epoch, or this market was already paid in it. Both mean
      // "not now", and neither may create a second payout.
      return this.#denied('MARKET_IN_COOLDOWN', [{
        code: 'MARKET_IN_COOLDOWN',
        message: `Market already evaluated in payout epoch ${epoch}.`,
      }], {
        marketAddress, evidence, decision, epoch, existing: claim.existing,
      });
    }

    // From here a durable claim exists, so every exit must resolve it.
    try {
      return await this.#executeClaimedEpoch({ evidence, decision, capped, epoch });
    } catch (error) {
      await this.autonomyStore.resolvePayoutEpoch({
        marketAddress: evidence.marketAddress,
        policyVersion: AUTONOMOUS_POLICY_VERSION,
        epoch,
        outcome: 'FAILED',
      });
      throw error;
    }
  }

  async #executeClaimedEpoch({ evidence, decision, capped, epoch }) {
    // 6. Quote and prepare through the existing Stage 1 settlement pipeline.
    //
    //    The caps above are expressed in what the creator actually receives, which is also
    //    exactly what leaves the wallet. Stage 1's settlement policy instead takes a *gross*
    //    request and pays the creator `creatorShareBps` of it, so the gross that delivers the
    //    decided payout is derived here. An inexact share configuration fails closed rather than
    //    quietly paying the creator less than policy decided.
    const gross = grossForCreatorPayout(capped.amountUnits, this.creatorShareBps);
    if (!gross.exact) {
      throw new DomainError(
        'AUTONOMOUS_PAYOUT_NOT_REPRESENTABLE',
        'The configured creator share cannot deliver the decided payout exactly.',
        {
          status: 500,
          details: {
            decidedUnits: capped.amountUnits.toString(),
            deliveredUnits: gross.deliveredUnits?.toString() ?? null,
            creatorShareBps: this.creatorShareBps,
          },
        },
      );
    }

    //    The idempotency key is the evidence identity, so a crash and restart resolves to the
    //    same settlement rather than creating a second one.
    const idempotencyKey = `autonomous:${evidence.marketAddress.toLowerCase()}:${AUTONOMOUS_POLICY_VERSION}:${epoch}`;
    const quote = await this.settlementService.quote({
      recipient: evidence.creatorAddress,
      requestedAmount: formatUsdc(gross.grossUnits),
      viralityScore: decision.confidenceAdjustedScore,
      reference: `AUTONOMOUS ${evidence.marketSymbol} EPOCH ${epoch}`,
    }, idempotencyKey, {
      agentDecision: decision,
      agentDailyCapUnits: this.agentPolicy.dailySpendUnits,
    });

    if (!quote.record.policy.approved) {
      await this.autonomyStore.resolvePayoutEpoch({
        marketAddress: evidence.marketAddress,
        policyVersion: AUTONOMOUS_POLICY_VERSION,
        epoch,
        outcome: 'DENIED',
      });
      return this.#denied('SETTLEMENT_POLICY_DENIED', quote.record.policy.reasons, {
        marketAddress: evidence.marketAddress, evidence, decision, settlement: quote.record,
      });
    }

    const prepared = await this.settlementService.prepare(quote.record.id);
    const decidedAt = this.now().toISOString();

    // 7. Mint the authority in-process. This is the only place it can come from.
    const authority = mintAutonomousAuthority({
      settlementId: prepared.id,
      marketAddress: evidence.marketAddress,
      creatorAddress: evidence.creatorAddress,
      evidenceDigest: evidence.evidenceDigest,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
      metricVersion: evidence.metrics.metricVersion,
      epoch,
      decidedAt,
      expiresAt: new Date(
        this.now().getTime() + this.decisionTtlSeconds * 1000,
      ).toISOString(),
      anchorBlockNumber: evidence.anchorBlockNumber,
      anchorBlockHash: evidence.anchorBlockHash,
      amountUnits: capped.amountUnits,
      grossUnits: gross.grossUnits,
    });

    // 8. Execute, with a preflight that re-checks everything volatile in the last moment.
    const executed = await this.settlementService.executeAutonomous(prepared.id, authority, {
      preflight: async (record) => {
        requireAutonomyActive(await this.autonomyStore.autonomyState());
        assertAutonomousAuthorityFresh(authority, this.now());
        const current = await this.collector.verifyEvidenceStillCanonical(evidence);
        if (getAddress(record.recipient) !== current.creatorAddress) {
          throw new DomainError(
            'AUTONOMOUS_RECIPIENT_DRIFT',
            'The settlement recipient no longer matches the market creator.',
            { status: 409 },
          );
        }
      },
    });

    await this.autonomyStore.resolvePayoutEpoch({
      marketAddress: evidence.marketAddress,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
      epoch,
      settlementId: executed.id,
      // The real spend: what the creator received and what left the wallet, not the gross
      // request. Daily caps therefore track actual money movement.
      amountUnits: capped.amountUnits,
      outcome: 'EXECUTED',
    });

    return Object.freeze({
      outcome: 'EXECUTED',
      marketAddress: evidence.marketAddress,
      creatorAddress: evidence.creatorAddress,
      epoch,
      evidence,
      decision,
      payout: {
        // What the creator receives, and what actually leaves the agent wallet.
        creatorPayoutUsdc: capped.amountUsdc,
        creatorPayoutUnits: capped.amountUnits.toString(),
        // The gross settlement request Stage 1 policy splits; the remainder is retained, never
        // transferred. Reported separately so the two can never be confused again.
        grossRequestUsdc: formatUsdc(gross.grossUnits),
        grossRequestUnits: gross.grossUnits.toString(),
        treasuryRetainedUsdc: formatUsdc(gross.grossUnits - capped.amountUnits),
        derivedUsdc: capped.derivedUsdc,
        capReasons: capped.reasons,
      },
      settlementId: executed.id,
      executionMode: executed.executionSubmission?.executionMode ?? null,
      circleTransactionId: executed.circle?.transactionId ?? null,
      transactionHash: executed.transactionHash ?? null,
      state: executed.state,
      settlement: executed,
    });
  }

  #denied(outcome, reasons, context = {}) {
    return Object.freeze({
      outcome,
      approved: false,
      reasons: reasons ?? [],
      marketAddress: context.marketAddress ?? null,
      creatorAddress: context.evidence?.creatorAddress ?? null,
      epoch: context.epoch ?? null,
      evidence: context.evidence ?? null,
      decision: context.decision ?? null,
      payout: context.capped
        ? {
          amountUsdc: formatUsdc(context.capped.amountUnits),
          derivedUsdc: context.capped.derivedUsdc,
          capReasons: context.capped.reasons,
        }
        : null,
      settlementId: context.settlement?.id ?? null,
    });
  }

  /**
   * Sanitized public view of the autonomous system, safe to render in a browser.
   *
   * This is what a judge reads to satisfy themselves that a real signal caused a real policy
   * decision which caused a real USDC transaction, so each recent payout is joined to the
   * evidence and Arc receipt that produced it. Everything included is either already public
   * onchain or a policy constant; no Circle wallet identifier, worker identity, session, or
   * credential is exposed.
   */
  async status() {
    const autonomy = await this.autonomyStore.autonomyState();
    const recent = await this.autonomyStore.listRecentEpochs(10);
    const executor = await this.#executorStatus();

    const payouts = await Promise.all(recent.map(async (entry) => {
      const base = {
        marketAddress: entry.marketAddress,
        creatorAddress: entry.creatorAddress,
        epoch: entry.epoch,
        evidenceDigest: entry.evidenceDigest,
        settlementId: entry.settlementId,
        amountUsdc: formatUsdc(entry.amountUnits),
        claimedAt: entry.claimedAt,
        resolvedAt: entry.resolvedAt,
        outcome: entry.outcome,
      };
      if (!entry.settlementId || !this.settlementService?.store?.get) return base;
      const settlement = await this.settlementService.store.get(entry.settlementId)
        .catch(() => null);
      if (!settlement) return base;
      const decision = settlement.agentDecision ?? null;
      return {
        ...base,
        state: settlement.state,
        executionMode: settlement.executionSubmission?.executionMode ?? null,
        // Proof there was no human in this payout, rendered directly rather than inferred.
        humanAuthorization: Boolean(
          settlement.executionAuthorization?.operatorAddress
          || settlement.executionAuthorization?.sessionId,
        ),
        creatorPayoutUsdc: settlement.amount?.creatorPayoutUsdc ?? null,
        signals: decision?.signals
          ? {
            engagementVelocity: decision.signals.engagementVelocity,
            holderRetention: decision.signals.holderRetention,
            liquidityDepth: decision.signals.liquidityDepth,
            confidence: decision.signals.confidence,
            fraudRisk: decision.signals.fraudRisk,
          }
          : null,
        score: decision?.confidenceAdjustedScore ?? null,
        provenance: decision?.evidence?.provenance ?? null,
        collector: decision?.evidence?.collector ?? null,
        fromBlock: decision?.evidence?.fromBlock ?? null,
        toBlock: decision?.evidence?.toBlock ?? null,
        anchorBlockHash: decision?.evidence?.anchorBlockHash ?? null,
        riskReasons: decision?.evidence?.riskReasons ?? [],
        rawEvidence: decision?.evidence?.raw ?? null,
        policyReasons: settlement.policy?.reasons ?? [],
        transactionHash: settlement.transactionHash ?? null,
        circleState: settlement.circle?.state ?? null,
        // The onchain executor address is public; the Circle wallet UUID is not exposed.
        executedBy: settlement.circle?.sourceAddress ?? null,
        settlementRoute: settlement.executionPlan?.operation ?? null,
        reconciliation: settlement.reconciliation
          ? {
            status: settlement.reconciliation.status,
            route: settlement.reconciliation.route ?? null,
            settlementContract: settlement.reconciliation.settlementContract ?? null,
            blockNumber: settlement.reconciliation.blockNumber ?? null,
            failures: settlement.reconciliation.failures ?? [],
          }
          : null,
      };
    }));

    return {
      policyVersion: AUTONOMOUS_POLICY_VERSION,
      metricVersion: 'AGENT_SIGNAL_METRICS_V1',
      paused: autonomy.paused,
      pauseReason: autonomy.reason,
      changedAt: autonomy.changedAt,
      executor,
      thresholds: {
        minConfidence: this.agentPolicy.minConfidence,
        maxFraudRisk: this.agentPolicy.maxFraudRisk,
        signalMaxAgeSeconds: this.agentPolicy.signalMaxAgeSeconds,
      },
      caps: {
        perExecutionUsdc: this.payoutPolicy.maxPayoutUsdc,
        minimumUsdc: this.payoutPolicy.minPayoutUsdc,
        marketDailyUsdc: this.payoutPolicy.marketDailyCapUsdc,
        globalDailyUsdc: this.payoutPolicy.dailySpendUsdc,
        scoreFloor: this.payoutPolicy.scoreFloor,
        cooldownSeconds: this.cooldownSeconds,
      },
      recentEpochs: payouts,
    };
  }

  /** Which wallet actually executes autonomous payouts, described truthfully. */
  async #executorStatus() {
    try {
      const readiness = await this.circleGateway?.readiness?.();
      if (!readiness?.configured) {
        return { configured: false, provider: readiness?.provider ?? null };
      }
      return {
        configured: true,
        provider: readiness.provider,
        address: readiness.wallet?.address ?? null,
        accountType: readiness.wallet?.accountType ?? null,
        state: readiness.wallet?.state ?? null,
        sessionStatus: readiness.sessionStatus ?? null,
        usdcBalance: readiness.usdcBalance ?? null,
      };
    } catch {
      return { configured: false, provider: null, state: 'UNAVAILABLE' };
    }
  }
}

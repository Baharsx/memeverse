import { createPublicClient, formatUnits, getAddress, http } from 'viem';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';
import { createSettlementRuntime } from '../server/runtime.js';

/**
 * Live Arc Testnet proof of one fully autonomous creator payout.
 *
 * The whole point is what this script does *not* do: it never supplies a recipient, an amount,
 * an observation timestamp, an execution mode, or an authorization. It resumes autonomy, names a
 * market, and lets the agent decide. Everything else is read from Arc by the collector and
 * derived by policy.
 *
 * Run with a small, explicit testnet payout envelope in uncommitted local configuration. The
 * committed defaults keep autonomy off and the caps tiny on purpose.
 */

loadLocalEnvironment();
const config = loadServerConfig();

const ARC_CHAIN_ID = 5042002;
const rpc = createPublicClient({ transport: http(config.arcRpcUrl) });

const usdcAbi = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }],
}];
const balanceOf = (owner) => rpc.readContract({
  address: getAddress(config.arcUsdcAddress), abi: usdcAbi, functionName: 'balanceOf',
  args: [getAddress(owner)],
});

const chainId = await rpc.getChainId();
if (chainId !== ARC_CHAIN_ID) {
  console.error(`Refusing to run: chain ${chainId}, expected ${ARC_CHAIN_ID}.`);
  process.exit(1);
}
if (!config.agentAutonomousEnabled) {
  console.error('AGENT_AUTONOMOUS_ENABLED must be true for this script. It is false by default.');
  process.exit(1);
}

const runtime = await createSettlementRuntime(config);
const {
  autonomousAgentService, autonomyStore, signalCollector,
  autonomousSettlementService, settlementService, agentWalletGateway,
} = runtime;
// The autonomous path must settle through the Circle Agent Wallet, not the manual treasury.
const reconcileService = autonomousSettlementService ?? settlementService;

try {
  console.log('MemeVerse autonomous creator settlement on Arc Testnet');
  console.log(`  chain:   ${chainId}`);
  console.log(`  factory: ${config.marketFactoryAddress}`);

  // ── Circle Agent Stack executor ──
  const agentReadiness = await agentWalletGateway.readiness();
  console.log('\n[0/5] Circle Agent Stack executor');
  console.log(`  provider:      ${agentReadiness.provider}`);
  console.log(`  agent wallet:  ${agentReadiness.wallet?.address}`);
  console.log(`  account type:  ${agentReadiness.wallet?.accountType} (ERC-4337 smart contract account)`);
  console.log(`  session:       ${agentReadiness.sessionStatus} (expires in ${agentReadiness.sessionExpiresIn})`);
  console.log(`  wallet USDC:   ${agentReadiness.usdcBalance}`);
  console.log(`  settlement:    ${config.agentSettlementContractAddress} (operator = agent wallet)`);
  if (!autonomousSettlementService) {
    throw new Error('The Circle Agent Wallet is not configured; refusing to fall back silently.');
  }
  if (agentReadiness.wallet?.state !== 'LIVE') {
    throw new Error('The Circle Agent Wallet session is not LIVE.');
  }

  const markets = await signalCollector.listRegisteredMarkets();
  if (markets.length === 0) throw new Error('The trusted factory has registered no markets.');
  const marketAddress = getAddress(process.env.AGENT_E2E_MARKET ?? markets[0]);
  console.log(`  markets: ${markets.length} registered, evaluating ${marketAddress}`);

  // ── The agent collects its own evidence. Nothing below is supplied by this script. ──
  console.log('\n[1/5] Collect confirmed Arc evidence');
  const evidence = await signalCollector.collect(marketAddress);
  console.log(`  provenance:    ONCHAIN_INDEXER (${evidence.collector})`);
  console.log(`  creator:       ${evidence.creatorAddress}  (read from market.creator())`);
  console.log(`  window:        blocks ${evidence.fromBlock} -> ${evidence.toBlock}`);
  console.log(`  head:          ${evidence.headBlock} (min confirmations ${config.agentMinConfirmations})`);
  console.log(`  anchor:        ${evidence.anchorBlockNumber} ${evidence.anchorBlockHash}`);
  console.log(`  observedAt:    ${evidence.observedAt} (from the anchor block, not the host clock)`);
  console.log(`  raw evidence:  ${JSON.stringify(evidence.metrics.raw)}`);
  console.log(`  signals:       ${JSON.stringify(evidence.metrics.signals)}`);
  console.log(`  risk reasons:  ${JSON.stringify(evidence.metrics.riskReasons)}`);
  console.log(`  digest:        ${evidence.evidenceDigest}`);

  const creatorBefore = await balanceOf(evidence.creatorAddress);
  console.log(`\n  creator USDC before: ${formatUnits(creatorBefore, 6)}`);

  // ── Resume autonomy. This is the only human act, and it is a switch, not an approval. ──
  console.log('\n[2/5] Resume autonomy (operator switch, not a payout approval)');
  const resumed = await autonomyStore.setAutonomyPaused({
    paused: false,
    reason: process.env.AGENT_E2E_REASON ?? 'stage-2 live autonomous evidence run',
    changedBy: 'stage-2-e2e',
  });
  console.log(`  paused: ${resumed.paused}`);

  // ── The agent decides and, if eligible, pays. No approval step exists in this path. ──
  console.log('\n[3/5] Agent evaluates and executes autonomously');
  const started = Date.now();
  const result = await autonomousAgentService.evaluateMarket(marketAddress);
  console.log(`  outcome: ${result.outcome} (in ${Date.now() - started} ms)`);

  if (result.outcome !== 'EXECUTED') {
    console.log('\n  The agent declined to pay. Reasons:');
    for (const reason of result.reasons ?? []) console.log(`    - ${reason.code}: ${reason.message}`);
    console.log('\n  This is a real policy denial, not a failure of the run.');
    if (result.decision) {
      console.log(`  confidence: ${result.decision.signals.confidence}`);
      console.log(`  fraudRisk:  ${result.decision.signals.fraudRisk}`);
      console.log(`  score:      ${result.decision.confidenceAdjustedScore}`);
    }
    process.exitCode = 2;
  } else {
    console.log(`  settlement:  ${result.settlementId}`);
    console.log(`  mode:        ${result.executionMode}`);
    console.log(`  recipient:   ${result.creatorAddress}`);
    console.log(`  creator payout: ${result.payout.creatorPayoutUsdc} USDC  <- leaves the wallet`);
    console.log(`  gross request:  ${result.payout.grossRequestUsdc} USDC  (Stage 1 policy input)`);
    console.log(`  treasury kept:  ${result.payout.treasuryRetainedUsdc} USDC (never transferred)`);
    console.log(`  epoch:       ${result.epoch}`);
    console.log(`  circle tx:   ${result.circleTransactionId}`);

    // ── Reconcile until Arc evidence is independently verified ──
    console.log('\n[4/5] Reconcile against Arc');
    let settlement = result.settlement;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      settlement = await reconcileService.reconcile(result.settlementId);
      if (settlement.reconciliation?.status === 'VERIFIED') break;
      if (settlement.state === 'FAILED') break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    console.log(`  state:          ${settlement.state}`);
    console.log(`  circle state:   ${settlement.circle?.state}`);
    console.log(`  arc tx:         ${settlement.transactionHash}`);
    console.log(`  reconciliation: ${settlement.reconciliation?.status}`);
    console.log(`  route:          ${settlement.reconciliation?.route}`);
    console.log(`  contract:       ${settlement.reconciliation?.settlementContract}`);
    console.log(`  onchain operator: ${settlement.reconciliation?.operator}`);
    if (settlement.reconciliation?.failures?.length) {
      console.log(`  failures:       ${JSON.stringify(settlement.reconciliation.failures)}`);
    }

    // ── Independent verification: no human authority, and a real balance delta ──
    console.log('\n[5/5] Independent verification');
    const creatorAfter = await balanceOf(evidence.creatorAddress);
    const delta = creatorAfter - creatorBefore;
    const expectedDelta = BigInt(result.payout.creatorPayoutUnits);
    const humanAuthorityUsed = Boolean(
      settlement.executionAuthorization?.operatorAddress
      || settlement.executionAuthorization?.sessionId,
    );
    console.log(`  creator USDC after:   ${formatUnits(creatorAfter, 6)} (delta +${formatUnits(delta, 6)})`);
    console.log(`  execution mode:       ${settlement.executionSubmission?.executionMode}`);
    console.log(`  operator address:     ${settlement.executionAuthorization?.operatorAddress ?? 'null'}`);
    console.log(`  operator session:     ${settlement.executionAuthorization?.sessionId ?? 'null'}`);
    console.log(`  human authorization:  ${humanAuthorityUsed ? 'YES' : 'NO'}`);
    console.log(`  provider calls:       ${settlement.executionAttempts?.length ?? 0} attempt(s)`);
    console.log(`  providerOperationKey: ${settlement.executionSubmission?.providerOperationKey}`);
    console.log(`  reservation:          ${settlement.reservation?.status}`);
    console.log(`  agent evidence:       ${JSON.stringify(settlement.executionSubmission?.agent)}`);
    console.log(`  executed by:          ${settlement.circle?.sourceAddress} (Circle Agent Wallet)`);
    console.log(`  execution plan:       ${settlement.executionPlan?.provider} / ${settlement.executionPlan?.operation}`);

    if (settlement.executionPlan?.provider !== 'CIRCLE_AGENT_WALLET') {
      throw new Error('The payout was not executed by the Circle Agent Wallet.');
    }
    if (getAddress(settlement.circle?.sourceAddress) !== getAddress(config.agentWalletAddress)) {
      throw new Error('The payout source address is not the Circle Agent Wallet.');
    }

    // The creator's balance must move by exactly the decided creator payout — not the gross.
    if (delta !== expectedDelta) {
      throw new Error(`Creator delta ${delta} does not equal the decided payout ${expectedDelta}.`);
    }
    if (humanAuthorityUsed) throw new Error('A human authority was recorded on an autonomous payout.');
    if (settlement.executionSubmission?.executionMode !== 'AUTONOMOUS_POLICY') {
      throw new Error('The payout was not executed under AUTONOMOUS_POLICY.');
    }

    // A second evaluation in the same epoch must not create a second payout.
    console.log('\n  Cooldown re-check: evaluating the same market again immediately');
    const repeat = await autonomousAgentService.evaluateMarket(marketAddress);
    console.log(`    outcome: ${repeat.outcome}`);
    if (repeat.outcome === 'EXECUTED') throw new Error('The cooldown failed to prevent a second payout.');
  }
} catch (error) {
  console.error(`\nAutonomous run failed: ${error?.message}`);
  console.error(error?.stack);
  process.exitCode = 1;
} finally {
  // Always leave autonomy paused after an evidence run, so an unattended machine is never left
  // able to spend on its own.
  await autonomyStore.setAutonomyPaused({
    paused: true, reason: 'stage-2 evidence run complete', changedBy: 'stage-2-e2e',
  });
  console.log('\nAutonomy paused again (fail-safe default restored).');
  await runtime.close();
}

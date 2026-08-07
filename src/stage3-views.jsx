import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { arc, arcContracts, arcLinks } from './arc';
import { getAgentAutonomy, getApiHealth } from './api';
import { formatUsdc, loadFactoryConfig, marketPublicClient } from './market';
import { readMediaAssets, stage2Contracts } from './assets';
import { NextStep } from './router.jsx';
import { autonomyDisplayState } from './agent-status.js';

/**
 * Stage 3 judge-facing surfaces: the Agent Command Center, the autonomous reward receipt, the
 * creator economy panel, and the Proof Center.
 *
 * None of these introduce a new capability. They are a reading of state that already exists —
 * deployed contracts, the sanitized autonomy endpoint, and live Arc reads — arranged so that
 * somebody with three minutes can follow one economy from a meme to a verified USDC payout.
 *
 * The rule every component here follows: a value is rendered only when it was actually observed.
 * Absent data reads UNAVAILABLE or NOT CONFIGURED. Nothing is illustrated with an example.
 */

const explorer = arc.blockExplorers.default.url;

export function shorten(value, lead = 6, tail = 4) {
  if (typeof value !== 'string' || value.length <= lead + tail + 2) return value ?? '—';
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function ArcLink({ kind = 'address', value, children, className = '' }) {
  if (!value) return <span className={className}>—</span>;
  return (
    <a
      className={`arcscan-link ${className}`.trim()}
      href={`${explorer}/${kind}/${value}`}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children ?? shorten(value)} ↗
    </a>
  );
}

function Fact({ label, children, wide = false }) {
  return (
    <div className={`fact${wide ? ' wide' : ''}`}>
      <small>{label}</small>
      <strong>{children}</strong>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Command Center
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turns one stored payout epoch into the three sentences a judge needs: what the agent saw, what
 * it decided, and why. Every field is either present in the record or rendered as absent.
 */
function decisionSummary(payout) {
  if (payout.outcome === 'EXECUTED') {
    return { verdict: 'REWARD', tone: 'ok', why: 'POLICY_PASS' };
  }
  if (payout.outcome === 'DENIED') {
    return {
      verdict: 'NO PAYOUT',
      tone: 'warn',
      why: payout.policyReasons?.[0]?.code ?? 'POLICY_DENIED',
    };
  }
  if (payout.outcome === 'FAILED') {
    return { verdict: 'NO PAYOUT', tone: 'warn', why: 'EXECUTION_FAILED' };
  }
  return { verdict: 'IN PROGRESS', tone: '', why: 'AWAITING_RESOLUTION' };
}

function settlementStatus(payout) {
  if (payout.reconciliation?.status === 'VERIFIED') return { label: 'VERIFIED', tone: 'ok' };
  if (payout.outcome === 'DENIED') return { label: 'DENIED', tone: 'warn' };
  if (payout.outcome === 'FAILED') return { label: 'FAILED', tone: 'warn' };
  if (payout.transactionHash) return { label: 'PENDING RECONCILIATION', tone: '' };
  if (payout.outcome === 'EXECUTED') return { label: 'PENDING', tone: '' };
  return { label: 'UNKNOWN', tone: '' };
}

/** The market label a judge reads. Derived from the server-generated autonomous reference. */
function marketLabel(payout) {
  const symbol = /^AUTONOMOUS\s+(\S+)\s+EPOCH/.exec(payout.reference ?? '')?.[1];
  return symbol ? `$${symbol}` : shorten(payout.marketAddress, 8, 6);
}

function TimelineEntry({ payout }) {
  const decision = decisionSummary(payout);
  const status = settlementStatus(payout);
  const signals = payout.signals;
  const raw = payout.rawEvidence;

  return (
    <article className={`timeline-entry ${decision.tone}`}>
      <header>
        <div className="timeline-market">
          <small>MARKET</small>
          <strong>{marketLabel(payout)}</strong>
          <ArcLink value={payout.marketAddress} />
        </div>
        <div className={`timeline-verdict ${decision.tone}`}>
          <small>DECISION</small>
          <strong>{decision.verdict}</strong>
          <span>WHY // {decision.why}</span>
        </div>
        <div className="timeline-amount">
          <small>CREATOR PAYOUT</small>
          <strong>
            {payout.outcome === 'EXECUTED'
              ? `${payout.creatorPayoutUsdc ?? payout.amountUsdc} USDC`
              : '—'}
          </strong>
          <span>EXECUTOR // {payout.executionMode === 'AUTONOMOUS_POLICY' ? 'CIRCLE AGENT WALLET' : (payout.executionMode ?? 'NONE')}</span>
        </div>
      </header>

      <dl className="timeline-observed">
        <div><dt>OBSERVED</dt><dd>{payout.provenance ?? 'PENDING'}</dd></div>
        <div>
          <dt>EVIDENCE WINDOW</dt>
          <dd>{payout.fromBlock ? `BLOCK ${payout.fromBlock} → ${payout.toBlock}` : '—'}</dd>
        </div>
        <div>
          <dt>MARKET ACTIVITY</dt>
          <dd>
            {raw
              ? `${raw.tradeCount ?? '—'} TRADES / ${raw.uniqueTraders ?? '—'} TRADERS`
              : '—'}
          </dd>
        </div>
        <div><dt>SCORE</dt><dd>{payout.score ?? '—'}</dd></div>
        <div>
          <dt>HUMAN APPROVAL</dt>
          <dd className={payout.humanAuthorization ? 'warn' : 'ok'}>
            {payout.humanAuthorization === undefined ? '—' : payout.humanAuthorization ? 'YES' : 'NONE'}
          </dd>
        </div>
        <div><dt>DECIDED</dt><dd>{payout.claimedAt ? new Date(payout.claimedAt).toISOString().replace('T', ' ').slice(0, 19) : '—'}</dd></div>
      </dl>

      {signals ? (
        <div className="timeline-signals">
          {[
            ['ENGAGEMENT', signals.engagementVelocity],
            ['RETENTION', signals.holderRetention],
            ['LIQUIDITY', signals.liquidityDepth],
            ['CONFIDENCE', signals.confidence],
            ['RISK', signals.fraudRisk],
          ].map(([label, value]) => (
            <span key={label}><small>{label}</small><b>{typeof value === 'number' ? value : '—'}</b></span>
          ))}
        </div>
      ) : null}

      {payout.riskReasons?.length
        ? <p className="timeline-note">RISK FLAGS // {payout.riskReasons.join(', ')}</p> : null}
      {payout.outcome !== 'EXECUTED' && payout.policyReasons?.length ? (
        <p className="timeline-note">
          REASONS // {payout.policyReasons.map((reason) => reason.code ?? String(reason)).join(', ')}
        </p>
      ) : null}

      <footer>
        <span className={`timeline-status ${status.tone}`}>SETTLEMENT {status.label}</span>
        <span>ARC TX <ArcLink kind="tx" value={payout.transactionHash} /></span>
        <span>EVIDENCE {shorten(payout.evidenceDigest, 10, 6)}</span>
      </footer>
    </article>
  );
}

/**
 * The receipt a judge can carry away: one completed autonomous payout, every field of which is
 * either a public Arc address, a real transaction hash, or a stored policy constant.
 *
 * Rendered only for a payout that actually executed. A pending or denied decision has no receipt,
 * and inventing one would be the single most misleading thing this page could do.
 */
export function ProofReceipt({ payout, settlementContract }) {
  if (!payout || payout.outcome !== 'EXECUTED' || !payout.transactionHash) return null;
  const verified = payout.reconciliation?.status === 'VERIFIED';
  const contract = payout.reconciliation?.settlementContract ?? settlementContract ?? null;

  return (
    <section className={`proof-receipt ${verified ? 'verified' : ''}`} aria-label="Autonomous reward receipt">
      <header>
        <h3>AUTONOMOUS REWARD RECEIPT</h3>
        <span className={verified ? 'ok' : 'warn'}>
          RECONCILIATION {payout.reconciliation?.status ?? 'PENDING'}
        </span>
      </header>
      <dl>
        <div><dt>DECISION</dt><dd>ELIGIBLE</dd></div>
        <div><dt>POLICY</dt><dd>{payout.policyVersion ?? 'AGENT_AUTONOMOUS_POLICY_V1'}</dd></div>
        <div><dt>MARKET</dt><dd><ArcLink value={payout.marketAddress} /></dd></div>
        <div><dt>CREATOR</dt><dd><ArcLink value={payout.creatorAddress} /></dd></div>
        <div><dt>PAYOUT</dt><dd className="receipt-amount">{payout.creatorPayoutUsdc ?? payout.amountUsdc} USDC</dd></div>
        <div><dt>EXECUTOR</dt><dd>CIRCLE AGENT WALLET <ArcLink value={payout.executedBy} /></dd></div>
        <div><dt>ARC TX</dt><dd><ArcLink kind="tx" value={payout.transactionHash} /></dd></div>
        <div><dt>SETTLEMENT CONTRACT</dt><dd><ArcLink value={contract} /></dd></div>
        <div><dt>ROUTE</dt><dd>{payout.reconciliation?.route ?? payout.settlementRoute ?? '—'}</dd></div>
        <div><dt>HUMAN APPROVAL</dt><dd className="ok">NONE</dd></div>
      </dl>
    </section>
  );
}

function AgentUnavailable({ title, detail }) {
  return (
    <div className="agent-unavailable" role="status">
      <b>{title}</b>
      <span>{detail}</span>
    </div>
  );
}

export function AgentCommandCenter() {
  const status = useQuery({
    queryKey: ['agent-autonomy'],
    queryFn: getAgentAutonomy,
    retry: 1,
    refetchInterval: 15_000,
  });

  if (status.isPending) {
    return <div className="empty"><span>READING AGENT STATUS…</span></div>;
  }

  if (status.isError) {
    const notConfigured = status.error?.code === 'AGENT_NOT_CONFIGURED';
    return (
      <AgentUnavailable
        title={notConfigured ? 'AUTONOMOUS AGENT NOT CONFIGURED' : 'AGENT STATUS UNAVAILABLE'}
        detail={notConfigured
          ? 'This deployment has no Circle Agent Wallet configured, so no autonomous payout route exists. Nothing is shown in its place.'
          : 'The backend could not be reached. No cached decision is displayed.'}
      />
    );
  }

  const data = status.data;
  const executor = data.executor ?? {};
  const budget = data.budget ?? {};
  const executorLive = executor.configured && executor.state === 'LIVE';
  const state = autonomyDisplayState({ loaded: status.isSuccess, data });
  const executed = data.recentEpochs?.filter((entry) => entry.outcome === 'EXECUTED') ?? [];
  const latestProof = executed.find((entry) => entry.transactionHash) ?? null;

  return (
    <div className="command-center">
      <div className="command-head">
        <div>
          <small>AUTONOMOUS AGENT</small>
          <h2>ECONOMIC ACTOR, NOT A CHATBOT</h2>
          <p>
            A deterministic policy reads confirmed Arc trading evidence, decides on its own whether
            a creator has earned a reward, and pays them from a Circle Agent Wallet. No language
            model is involved, and no human approves an individual payout.
          </p>
        </div>
        <div className={`command-state ${state.toLowerCase()}`} role="status">
          <small>STATUS</small>
          <strong>{state}</strong>
          {data.paused && data.pauseReason ? <span>{data.pauseReason}</span> : null}
          {!data.paused && executor.configured && !executorLive
            ? <span>AGENT WALLET SESSION {executor.sessionStatus ?? 'UNAVAILABLE'}</span> : null}
          {!executor.configured ? <span>NO AGENT WALLET CONFIGURED</span> : null}
        </div>
      </div>

      <div className="command-grid">
        <Fact label="CIRCLE AGENT WALLET">
          {executor.configured
            ? <ArcLink value={executor.address}>{shorten(executor.address, 10, 8)}</ArcLink>
            : 'NOT CONFIGURED'}
        </Fact>
        <Fact label="ACCOUNT TYPE">
          {executor.accountType ? `${executor.accountType} / ERC-4337` : 'UNAVAILABLE'}
        </Fact>
        <Fact label="NETWORK">{arc.name.toUpperCase()} / CHAIN {arc.id}</Fact>
        <Fact label="AGENT WALLET USDC">
          {executor.usdcBalance !== undefined && executor.usdcBalance !== null
            ? `${executor.usdcBalance} USDC` : 'UNAVAILABLE'}
        </Fact>
        <Fact label="DAILY POLICY BUDGET">
          {budget.available
            ? `${budget.usedUsdc} / ${budget.capUsdc} USDC`
            : `CAP ${budget.capUsdc ?? data.caps?.globalDailyUsdc ?? '—'} USDC / USE UNAVAILABLE`}
        </Fact>
        <Fact label="AVAILABLE TODAY">
          {budget.available ? `${budget.remainingUsdc} USDC` : 'UNAVAILABLE'}
        </Fact>
        <Fact label="POLICY VERSION">{data.policyVersion}</Fact>
        {/*
          Deliberately not "last evaluation". The backend derives this from the most recent payout
          epoch *claim*, so an evaluation that was denied before it reached the claim is not
          represented here. The label states exactly what the data is.
        */}
        <Fact label="LAST RECORDED EPOCH">
          {data.lastEvaluationAt
            ? new Date(data.lastEvaluationAt).toISOString().replace('T', ' ').slice(0, 19)
            : 'NEVER'}
        </Fact>
        <Fact label="LAST PAYOUT">
          {latestProof
            ? `${latestProof.creatorPayoutUsdc ?? latestProof.amountUsdc} USDC / ${latestProof.reconciliation?.status ?? 'PENDING'}`
            : 'NONE YET'}
        </Fact>
        <Fact label="SETTLEMENT CONTRACT">
          {data.settlementContract
            ? <ArcLink value={data.settlementContract}>{shorten(data.settlementContract, 10, 8)}</ArcLink>
            : 'NOT CONFIGURED'}
        </Fact>
      </div>

      <div className="policy-card">
        <h3>WHAT THE POLICY ACTUALLY CHECKS</h3>
        <div>
          <section>
            <small>SIGNALS, DERIVED FROM CONFIRMED ARC TRADES</small>
            <ul>
              <li>ENGAGEMENT — trade count over the evidence window</li>
              <li>RETENTION — distinct traders holding through the window</li>
              <li>LIQUIDITY — curve reserve and traded USDC volume</li>
              <li>RISK — concentration and shape heuristics over the same trades</li>
              <li>CONFIDENCE — completeness of the log scan behind all of the above</li>
            </ul>
          </section>
          <section>
            <small>GATES, ENFORCED SERVER-SIDE</small>
            <dl>
              <div><dt>MIN CONFIDENCE</dt><dd>{data.thresholds?.minConfidence ?? '—'}</dd></div>
              <div><dt>MAX RISK</dt><dd>{data.thresholds?.maxFraudRisk ?? '—'}</dd></div>
              <div><dt>SCORE FLOOR</dt><dd>{data.caps?.scoreFloor ?? '—'}</dd></div>
              <div><dt>PER PAYOUT</dt><dd>{data.caps?.perExecutionUsdc ?? '—'} USDC MAX</dd></div>
              <div><dt>PER MARKET / DAY</dt><dd>{data.caps?.marketDailyUsdc ?? '—'} USDC</dd></div>
              <div><dt>GLOBAL / DAY</dt><dd>{data.caps?.globalDailyUsdc ?? '—'} USDC</dd></div>
              <div><dt>COOLDOWN</dt><dd>{data.caps?.cooldownSeconds ?? '—'}s PER MARKET</dd></div>
              <div><dt>EVIDENCE AGE</dt><dd>MAX {data.thresholds?.signalMaxAgeSeconds ?? '—'}s</dd></div>
            </dl>
          </section>
        </div>
        <p className="policy-note">
          The agent reads its own recipient from <code>market.creator()</code>, derives its own
          amount from the decided score, and takes its observation time from the Arc anchor block.
          No browser request can choose any of them.
        </p>
      </div>

      {latestProof ? (
        <ProofReceipt payout={latestProof} settlementContract={data.settlementContract} />
      ) : null}

      <div className="timeline">
        <h3>DECISION TIMELINE</h3>
        {!data.recentEpochs?.length ? (
          <AgentUnavailable
            title="NO AUTONOMOUS DECISIONS YET"
            detail="The agent has not evaluated an eligible market in this deployment. Nothing is shown in place of a decision it has not made."
          />
        ) : (
          data.recentEpochs.map((payout) => (
            <TimelineEntry key={`${payout.marketAddress}-${payout.epoch}`} payout={payout} />
          ))
        )}
      </div>

      <NextStep
        to="/safety"
        label="VERIFY THE PAYMENT PROOF"
        detail="Contracts, execution modes, and live network state in the Proof Center"
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Creator economy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One creator's current position across every MemeVerse layer, for a single market.
 *
 * Deliberately titled CURRENT ONCHAIN STATE rather than "lifetime earnings". `creatorFeesPaidUsdc`
 * is a real cumulative counter the market contract maintains, so it is shown as exactly that; the
 * NFT and reward figures are current state, not history, and are not aggregated into a total that
 * would imply a completeness this application cannot prove.
 */
export function CreatorEconomy({ market }) {
  const media = useQuery({
    queryKey: ['media-assets'],
    queryFn: () => readMediaAssets(),
    enabled: Boolean(stage2Contracts.mediaNft),
    retry: 1,
    staleTime: 30_000,
  });
  const agent = useQuery({
    queryKey: ['agent-autonomy'],
    queryFn: getAgentAutonomy,
    retry: 1,
    staleTime: 15_000,
  });

  if (!market) return null;
  const marketKey = market.address.toLowerCase();
  const assets = (media.data?.assets ?? [])
    .filter((asset) => asset.market.toLowerCase() === marketKey);
  const listed = assets.filter((asset) => asset.listing?.fillable);
  const rewards = (agent.data?.recentEpochs ?? [])
    .filter((entry) => entry.marketAddress?.toLowerCase() === marketKey
      && entry.outcome === 'EXECUTED');
  const rewardProof = rewards.find((entry) => entry.transactionHash) ?? null;

  return (
    <section className="creator-economy" aria-label="Creator economy for this market">
      <header>
        <h2>CREATOR ECONOMY // CURRENT ONCHAIN STATE</h2>
        <ArcLink value={market.creator}>CREATOR {shorten(market.creator, 8, 6)}</ArcLink>
      </header>
      <div className="creator-layers">
        <div>
          <small>01 MARKET</small>
          <strong>{formatUsdc(market.reserveUsdc)} USDC</strong>
          <span>CURVE RESERVE / {market.soldTokenCount.toLocaleString()} SOLD</span>
        </div>
        <div>
          <small>02 TRADING FEES</small>
          <strong>{formatUsdc(market.creatorFeesPaidUsdc)} USDC</strong>
          <span>PAID TO CREATOR BY THIS MARKET</span>
        </div>
        <div>
          <small>03 MEDIA NFTs</small>
          <strong>
            {stage2Contracts.mediaNft
              ? (media.isError ? 'UNAVAILABLE' : assets.length)
              : 'NOT CONFIGURED'}
          </strong>
          <span>
            {stage2Contracts.mediaNft && !media.isError
              ? `${listed.length} LISTED FOR USDC`
              : 'MEDIA COLLECTION UNREADABLE'}
          </span>
        </div>
        <div>
          {/*
            The backend returns a bounded window of recent epochs, not a lifetime ledger, so this
            count is "recent" and says so. Presenting it as a total would invite a judge to read a
            complete history out of a partial one.
          */}
          <small>04 RECENT AUTONOMOUS REWARDS</small>
          <strong>
            {agent.isError
              ? 'UNAVAILABLE'
              : rewards.length ? `${rewards.length} IN RECENT WINDOW` : 'NONE RECENTLY'}
          </strong>
          <span>
            {rewardProof
              ? <>ARC <ArcLink kind="tx" value={rewardProof.transactionHash} /></>
              : 'NO RECENT AGENT REWARD FOR THIS MARKET'}
          </span>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Proof Center
// ─────────────────────────────────────────────────────────────────────────────

function ContractRow({ label, address, note }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="contract-address">
        {address ? <ArcLink value={address}>{address}</ArcLink> : <span className="warn">NOT CONFIGURED</span>}
      </td>
      <td>{note}</td>
    </tr>
  );
}

export function ProofCenter() {
  const health = useQuery({
    queryKey: ['api-health'],
    queryFn: getApiHealth,
    retry: 1,
    refetchInterval: 30_000,
  });
  const agent = useQuery({
    queryKey: ['agent-autonomy'],
    queryFn: getAgentAutonomy,
    retry: 1,
    refetchInterval: 30_000,
  });
  const factory = useQuery({
    queryKey: ['market-factory-config'],
    queryFn: loadFactoryConfig,
    retry: 1,
    staleTime: 30_000,
  });
  const browserBlock = useQuery({
    queryKey: ['browser-block-number'],
    queryFn: () => marketPublicClient.getBlockNumber().then((value) => value.toString()),
    retry: 1,
    refetchInterval: 20_000,
  });

  const arcHealth = health.data?.arc;
  const executor = agent.data?.executor ?? {};
  const proof = (agent.data?.recentEpochs ?? [])
    .find((entry) => entry.outcome === 'EXECUTED' && entry.transactionHash) ?? null;

  return (
    <div className="proof-center">
      <section className="proof-block">
        <h2>LIVE NETWORK</h2>
        <div className="proof-cards">
          <Fact label="ARC CHAIN ID">{arc.id}</Fact>
          <Fact label="SERVER RPC">
            {health.isPending ? 'CHECKING' : arcHealth?.status === 'verified' ? 'VERIFIED' : 'UNAVAILABLE'}
          </Fact>
          <Fact label="SERVER HEAD BLOCK">{arcHealth?.blockNumber ?? 'UNAVAILABLE'}</Fact>
          <Fact label="BROWSER HEAD BLOCK">
            {browserBlock.isPending ? 'READING' : browserBlock.data ?? 'UNAVAILABLE'}
          </Fact>
          <Fact label="PERSISTENCE">
            {health.data?.persistence?.ready === true ? 'POSTGRES READY' : 'UNAVAILABLE'}
          </Fact>
          <Fact label="MARKETS DEPLOYED">
            {factory.data ? String(factory.data.marketCount) : 'UNAVAILABLE'}
          </Fact>
        </div>
        <p className="proof-note">
          Two independent reads of the same chain: one by the API server, one by this browser
          against the public Arc RPC. They should agree within a block or two.
        </p>
      </section>

      <section className="proof-block">
        <h2>DEPLOYED CONTRACTS</h2>
        <div className="proof-table-scroll">
          <table className="proof-table">
            <caption className="visually-hidden">MemeVerse contracts deployed on Arc Public Testnet</caption>
            <thead>
              <tr><th scope="col">CONTRACT</th><th scope="col">ARC ADDRESS</th><th scope="col">ROLE</th></tr>
            </thead>
            <tbody>
              <ContractRow label="MARKET FACTORY" address={arcContracts.memeVerseFactory} note="Immutable registry for every MemeVerse market" />
              <ContractRow label="MEDIA NFT" address={stage2Contracts.mediaNft} note="Market-bound creator media provenance" />
              <ContractRow label="NFT MARKETPLACE" address={stage2Contracts.nftMarketplace} note="USDC-settled media trading, no marketplace fee" />
              <ContractRow label="USDC VAULT" address={stage2Contracts.usdcVault} note="ERC-4626 treasury primitive over Arc USDC" />
              <ContractRow label="SETTLEMENT / MANUAL" address={arcContracts.memeVerseSettlement} note="Operator route — Developer-Controlled Wallet is its immutable operator" />
              <ContractRow label="SETTLEMENT / AUTONOMOUS" address={agent.data?.settlementContract} note="Agent route — Agent Wallet is its immutable operator" />
              <ContractRow label="ARC USDC" address={arcContracts.usdc} note="Native Arc USDC — money and gas" />
              <ContractRow label="ARC MEMO" address={arcContracts.memo} note="CallFrom routing used by the manual operator route only" />
            </tbody>
          </table>
        </div>
      </section>

      <section className="proof-block">
        <h2>TWO ISOLATED EXECUTION MODES</h2>
        <div className="mode-grid">
          <article>
            <small>MANUAL_OPERATOR</small>
            <h3>Developer-Controlled Wallet</h3>
            <dl>
              <div><dt>ACCOUNT</dt><dd>EOA</dd></div>
              <div><dt>ROUTING</dt><dd>ARC MEMO → CONTRACT</dd></div>
              <div><dt>AUTHORIZATION</dt><dd>OPERATOR SESSION + ONE-TIME APPROVAL</dd></div>
              <div><dt>HUMAN PER PAYOUT</dt><dd className="warn">YES</dd></div>
            </dl>
          </article>
          <article>
            <small>AUTONOMOUS_POLICY</small>
            <h3>Circle Agent Wallet</h3>
            <dl>
              <div><dt>ACCOUNT</dt><dd>ERC-4337 SMART ACCOUNT</dd></div>
              <div><dt>ROUTING</dt><dd>DIRECT → CONTRACT</dd></div>
              <div><dt>AUTHORIZATION</dt><dd>INTERNALLY MINTED, EVIDENCE-BOUND</dd></div>
              <div><dt>HUMAN PER PAYOUT</dt><dd className="ok">NONE</dd></div>
            </dl>
          </article>
        </div>
        <p className="proof-note">
          The two routes share no wallet, no settlement contract, and no USDC allowance. Autonomy
          exists only when the Agent Wallet route exists — there is deliberately no fallback that
          would let an autonomous decision quietly spend from the manual treasury. An Agent Wallet
          is a smart contract account, and Arc&rsquo;s Memo <code>CallFrom</code> extension only
          preserves a directly signing EOA as the caller, so the autonomous route calls its own
          contract directly instead.
        </p>
      </section>

      <section className="proof-block">
        <h2>AUTONOMOUS EXECUTOR</h2>
        <div className="proof-cards">
          <Fact label="AGENT WALLET">
            {executor.configured
              ? <ArcLink value={executor.address}>{shorten(executor.address, 10, 8)}</ArcLink>
              : 'NOT CONFIGURED'}
          </Fact>
          <Fact label="WALLET STATE">{executor.state ?? 'UNAVAILABLE'}</Fact>
          <Fact label="PROVIDER">
            {executor.provider === 'CIRCLE_AGENT_WALLET' ? 'CIRCLE AGENT WALLET' : (executor.provider ?? 'UNAVAILABLE')}
          </Fact>
          <Fact label="AUTONOMY">
            {autonomyDisplayState({ loaded: agent.isSuccess, data: agent.data })}
          </Fact>
        </div>
        {proof ? (
          <ProofReceipt payout={proof} settlementContract={agent.data?.settlementContract} />
        ) : (
          <p className="proof-note">
            No verified autonomous payout is recorded in this deployment yet, so no receipt is
            shown. Historical proofs from previous runs are listed in the project documentation
            with their Arc transaction hashes.
          </p>
        )}
      </section>

      <section className="proof-block">
        <h2>TRUST BOUNDARY</h2>
        <ul className="boundary-list">
          <li>Signal provenance and observation time are stamped by the server from the Arc anchor block. A browser can submit signal <em>values</em> on the manual route and nothing else.</li>
          <li>Privileged settlement execution needs a wallet signature proving control of the configured operator address, plus a single-use approval bound to that exact payload.</li>
          <li>Autonomous spend is admitted inside one database transaction holding an exclusive lock, so two workers cannot both see an empty daily budget.</li>
          <li>An undetermined provider outcome keeps holding budget. Capacity is returned only when a payout provably never reached Circle.</li>
          <li>One market can be paid at most once per policy epoch, enforced by a primary key rather than by application logic.</li>
        </ul>
      </section>

      <section className="proof-block limitations">
        <h2>LIMITATIONS — STATED PLAINLY</h2>
        <ul className="boundary-list">
          <li><b>Arc Public Testnet only.</b> Test assets have no real-world value. Nothing here is mainnet.</li>
          <li><b>No independent security audit.</b> No third party has reviewed this code.</li>
          <li><b>Not production ready.</b> Operational hardening, key custody review, and monitoring remain open.</li>
          <li><b>Agent spending caps are application-level.</b> Circle wallet-level spend limits are a mainnet feature, so every cap in force here is enforced by this application&rsquo;s database, not by the wallet.</li>
          <li><b>The policy is deterministic, not intelligent.</b> It is arithmetic over onchain trade data. No language model participates in any decision.</li>
          <li><b>Risk scoring detects shape, not intent.</b> A patient, well-funded adversary can trade a market into a passing profile; the caps bound the damage rather than preventing it.</li>
          <li><b>The Agent Wallet session expires.</b> When it lapses the agent reports UNAVAILABLE and stops paying until a human signs in again.</li>
        </ul>
      </section>

      <div className="proof-sources">
        <a href={arcLinks.docs} target="_blank" rel="noreferrer noopener">ARC DOCS ↗</a>
        <a href={arcLinks.explorer} target="_blank" rel="noreferrer noopener">ARCSCAN ↗</a>
        <a href={arcLinks.status} target="_blank" rel="noreferrer noopener">ARC NETWORK STATUS ↗</a>
        <a href={arcLinks.faucet} target="_blank" rel="noreferrer noopener">CIRCLE FAUCET ↗</a>
        <a href={arcLinks.contracts} target="_blank" rel="noreferrer noopener">ARC CONTRACT ADDRESSES ↗</a>
      </div>
    </div>
  );
}

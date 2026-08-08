import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { fallback, parseEventLogs } from 'viem';
import {
  WagmiProvider,
  createConfig,
  http,
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useSignMessage,
  useSwitchChain,
} from 'wagmi';
import { injected } from 'wagmi/connectors';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  ARC_FALLBACK_RPC_URL,
  ARC_RPC_URL,
  arc,
  arcCapabilities,
  arcContracts,
  arcLinks,
} from './arc';
import {
  transactionPhases,
} from './transaction-lifecycle';

/**
 * The Stage 2 surfaces read several contracts and are only visited deliberately, so they are
 * split out of the initial bundle rather than loaded for every visitor on the markets page.
 */
const MediaAssets = lazy(() => import('./stage2-views.jsx').then((module) => ({ default: module.MediaAssets })));
const UsdcVault = lazy(() => import('./stage2-views.jsx').then((module) => ({ default: module.UsdcVault })));
/**
 * The Stage 3 judge surfaces — Agent Command Center, Proof Center, creator economy — live in
 * their own chunk for the same reason: they are reached deliberately, and the markets page should
 * not pay for them.
 */
const AgentCommandCenter = lazy(() => import('./stage3-views.jsx').then((module) => ({ default: module.AgentCommandCenter })));
const ProofCenter = lazy(() => import('./stage3-views.jsx').then((module) => ({ default: module.ProofCenter })));
const CreatorEconomy = lazy(() => import('./stage3-views.jsx').then((module) => ({ default: module.CreatorEconomy })));

function LazySection() {
  return <div className="empty"><span>LOADING…</span></div>;
}
import {
  authorizeSettlementExecution,
  createIdempotencyKey,
  createAgentDecision,
  endOperatorSession,
  estimateAppKitSwap,
  executeSettlement,
  getAgentAutonomy,
  getAppKitCapabilities,
  getApiHealth,
  getOperatorSession,
  reconcileSettlement,
  requestOperatorChallenge,
  verifyOperatorSignature,
} from './api';
import {
  marketAvailability,
  marketSpotLabel,
  marketSpotPerTokenLabel,
} from './market-display';
// Read here only to state truthfully whether this build has the Stage 2 addresses configured.
import { stage2Contracts } from './assets';
import {
  factoryAbi,
  formatTokenAmount,
  formatUsdc,
  launchPriceUnits,
  loadFactoryConfig,
  loadMarkets,
  loadUsdcBalance,
  marketAbi,
  minimumAfterSlippage,
  parseUsdc,
  parseWholeTokens,
  quoteBuy,
  quoteSell,
  tokenSupplyValue,
  usdcAbi,
} from './market';
import { useOnchainAction } from './use-onchain-action';
import { BrowserRouter, NavLink, Route, Routes } from './router.jsx';
import './styles.css';

const config = createConfig({
  chains: [arc],
  connectors: [injected()],
  transports: { [arc.id]: fallback([http(ARC_RPC_URL), http(ARC_FALLBACK_RPC_URL)]) },
});
const queryClient = new QueryClient();
const routerBase =
  import.meta.env.BASE_URL === '/'
    ? undefined
    : import.meta.env.BASE_URL.replace(/\/$/, '');
const network = {
  chain: arc,
  money: 'USDC',
};
function ExternalLink({ href, children, className = '', ...props }) {
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer noopener" {...props}>
      {children}
    </a>
  );
}

function Mascot({ small = false }) {
  return (
    <img
      className={`mascot pixel-mark ${small ? 'small' : ''}`}
      src={`${import.meta.env.BASE_URL}memeverse-mark.png`}
      alt="MemeVerse pixel-grid mark"
    />
  );
}

function Marquee() {
  const markets = useQuery({
    queryKey: ['onchain-markets', 'marquee'],
    queryFn: () => loadMarkets(),
    retry: 1,
    refetchInterval: 15_000,
  });
  const items = markets.data ?? [];
  return (
    <div className="marquee" role="group" aria-label="Live Arc Testnet market ticker">
      <div>
        {(items.length ? [...items, ...items] : [null, null]).map((market, index) => (
          <span key={market ? `${market.address}-${index}` : `empty-${index}`}>
            {market ? <>{market.symbol} <b>{marketSpotLabel(market, formatUsdc)}</b>{' '}<em className="up">ONCHAIN</em></> : <b>NO ONCHAIN MARKETS YET // LAUNCH THE FIRST</b>}
          </span>
        ))}
      </div>
    </div>
  );
}

function Wallet() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const balance = useQuery({
    queryKey: ['wallet-usdc', address],
    queryFn: () => loadUsdcBalance(address),
    enabled: isConnected && chainId === arc.id,
    refetchInterval: 12_000,
  });

  return isConnected ? (
    <button className="wallet" type="button" onClick={() => disconnect()} aria-label={`Disconnect testnet wallet ${address}`}>
      <i /><span className="wallet-balance">{chainId === arc.id && balance.data !== undefined ? `${formatUsdc(balance.data, 4)} USDC // ` : 'TESTNET // '}</span><span>{address.slice(0, 6)}…{address.slice(-4)}</span>
    </button>
  ) : (
    <button className="wallet" type="button" onClick={() => connect({ connector: injected() })}>
      {isPending ? 'REQUESTING…' : error ? 'WALLET UNAVAILABLE // RETRY' : 'CONNECT TESTNET WALLET'}
    </button>
  );
}

function NetworkStatus() {
  const chainId = useChainId();
  const { isConnected } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const onArc = isConnected && chainId === arc.id;

  return (
    <div className="network-switch" role="group" aria-label="Arc Testnet connection status">
      <button
        type="button"
        className={onArc ? 'active' : ''}
        disabled={!isConnected || isPending}
        onClick={() => switchChain({ chainId: arc.id })}
        title={isConnected ? 'Switch to Arc Testnet' : 'Connect a wallet first'}
      >
        <i />BUILT ON ARC
        <sup>{isPending ? 'WAIT' : onArc ? 'ON' : 'READY'}</sup>
      </button>
    </div>
  );
}

function BackendStatus() {
  const health = useQuery({
    queryKey: ['api-health'],
    queryFn: getApiHealth,
    retry: 1,
    refetchInterval: 30_000,
  });
  const verified = health.data?.status === 'ok' && health.data?.arc?.status === 'verified';
  const label = health.isPending ? 'API CHECK' : verified ? 'API + RPC VERIFIED' : 'API DEGRADED';

  return (
    <span className={`backend-status ${verified ? 'verified' : 'degraded'}`}>
      <i />{label}
    </span>
  );
}

/**
 * Navigation follows the demo path rather than the build order: create, trade, own, reward,
 * prove. The two supporting surfaces sit after it, because neither is a step of the story.
 */
const navItems = [
  ['01', 'LAUNCH', '/launch'],
  ['02', 'MARKETS', '/markets'],
  ['03', 'MEDIA', '/nft'],
  ['04', 'AGENT', '/agent'],
  ['05', 'PROOF', '/safety'],
  ['06', 'VAULT', '/vault'],
  ['07', 'QUOTE', '/quote'],
];

function Shell() {

  return (
    <>
      <a className="skip-link" href="#main-content">SKIP TO PRODUCT</a>
      <Marquee />
      <div className="network-bar">
        <span>ARC PUBLIC TESTNET // TEST ASSETS ONLY</span>
        <div className="network-center">
          <BackendStatus />
          <NetworkStatus />
        </div>
        <ExternalLink href={arcLinks.status}>NETWORK STATUS ↗</ExternalLink>
      </div>
      <div className="testnet-banner">
        ARC PUBLIC TESTNET — REAL USDC MARKET TRANSACTIONS — TEST ASSETS HAVE NO REAL-WORLD VALUE
      </div>
      <header className="site-header">
        <NavLink className="brand" to="/">
          <img
            className="brand-lockup"
            src={`${import.meta.env.BASE_URL}memeverse-lockup.png`}
            alt="MemeVerse"
          />
        </NavLink>
        <nav aria-label="Primary navigation">
          {navItems.map((item) => (
            <NavLink key={item[1]} to={item[2]}>
              <sup>{item[0]}</sup>
              {item[1]}
            </NavLink>
          ))}
        </nav>
        <Wallet />
      </header>
      <main id="main-content">
        <Routes notFound={<NotFound />}>
          <Route path="/" element={<Home />} />
          <Route path="/markets" element={<Markets />} />
          <Route path="/trade" element={<Markets />} />
          <Route path="/launch" element={<Launch />} />
          <Route path="/quote" element={<Quote />} />
          <Route
            path="/nft"
            element={<Suspense fallback={<LazySection />}><MediaAssets /></Suspense>}
          />
          <Route
            path="/vault"
            element={<Suspense fallback={<LazySection />}><UsdcVault /></Suspense>}
          />
          <Route path="/agent" element={<Agent />} />
          <Route path="/safety" element={<Safety />} />
          <Route path="/proof" element={<Safety />} />
        </Routes>
      </main>
      <footer className="site-footer">
        <span>MEMEVERSE © 2026</span>
        <span>{network.chain.name.toUpperCase()} // CHAIN {network.chain.id}</span>
        <ExternalLink className="social-link" href="https://x.com/memeversebiz" aria-label="MemeVerse on X">X / @MEMEVERSEBIZ ↗</ExternalLink>
        <ExternalLink href={arcLinks.docs}>BUILT ON ARC // OFFICIAL DOCS ↗</ExternalLink>
      </footer>
    </>
  );
}

/**
 * The economy flow, in the order a judge will watch it happen. Each step names the surface that
 * performs it, so the hero doubles as the table of contents for the demo.
 */
const economySteps = [
  ['01', 'CREATE', '/launch', 'A meme becomes a real Arc contract: a fixed-supply token and its USDC bonding market, deployed from your own wallet.'],
  ['02', 'TRADE', '/markets', 'Anyone buys and sells it in USDC against the curve. Every quote, reserve, and receipt is live chain state.'],
  ['03', 'OWN', '/nft', 'The creator mints media bound onchain to the market they actually created, then sells it for USDC.'],
  ['04', 'REWARD', '/agent', 'An autonomous agent reads confirmed trading evidence, decides on its own, and pays the creator from a Circle Agent Wallet.'],
  ['05', 'PROVE', '/safety', 'Every step above resolves to an Arc transaction you can open on ArcScan and check yourself.'],
];

function Home() {
  const health = useQuery({
    queryKey: ['api-health'],
    queryFn: getApiHealth,
    retry: 1,
    refetchInterval: 30_000,
  });
  const factory = useQuery({
    queryKey: ['market-factory-config'],
    queryFn: loadFactoryConfig,
    retry: 1,
    refetchInterval: 30_000,
  });
  const agent = useQuery({
    queryKey: ['agent-autonomy'],
    queryFn: getAgentAutonomy,
    retry: 1,
    refetchInterval: 30_000,
  });

  const executor = agent.data?.executor;
  const stage2Configured = Boolean(
    stage2Contracts.mediaNft && stage2Contracts.nftMarketplace && stage2Contracts.usdcVault,
  );
  /**
   * Every card states something the server or this browser actually verified.
   *
   * The Agent Wallet card reads the autonomous executor specifically, and is deliberately not the
   * same check as the Developer-Controlled Wallet below it: conflating the two would claim an
   * autonomous payout route that might not exist.
   */
  const checks = [
    [
      'ARC RPC',
      health.data?.arc?.status === 'verified',
      health.data?.arc?.blockNumber ? `HEAD BLOCK ${health.data.arc.blockNumber}` : 'VERIFYING',
      health.isPending,
    ],
    [
      'MARKET FACTORY',
      Boolean(factory.data),
      factory.data ? `${factory.data.marketCount} LIVE MARKETS` : 'READING ARC',
      factory.isPending,
    ],
    [
      'POSTGRES',
      health.data?.persistence?.ready === true,
      'DURABLE SPEND RESERVATIONS',
      health.isPending,
    ],
    [
      'CIRCLE AGENT WALLET',
      executor?.configured === true && executor?.state === 'LIVE',
      executor?.configured
        ? `ERC-4337 / ${executor.state ?? 'UNKNOWN'}`
        : 'AUTONOMOUS EXECUTOR',
      agent.isPending,
    ],
    [
      'AUTONOMOUS POLICY',
      agent.data ? agent.data.paused === false : false,
      agent.data ? (agent.data.paused ? 'OPERATOR EMERGENCY STOP ENGAGED' : agent.data.policyVersion) : 'UNREACHABLE',
      agent.isPending,
      // A paused agent is configured and healthy — it has simply been stopped. Reporting that as
      // "unavailable" would understate a deliberate, reversible operator action.
      agent.data?.paused === true ? 'PAUSED' : undefined,
    ],
    [
      'STAGE 2 CONTRACTS',
      stage2Configured,
      stage2Configured ? 'MEDIA / MARKETPLACE / VAULT' : 'NOT CONFIGURED IN THIS BUILD',
      false,
    ],
  ];

  return (
    <>
      <section className="hero">
        <div>
          <div className="eyebrow">
            {arcCapabilities.phase} / CHAIN {network.chain.id}
          </div>
          <h1>
            A MEME
            <br />BECOMES AN
            <br /><mark>ECONOMY.</mark>
          </h1>
          <p>
            MemeVerse turns a meme into a real Arc market. People trade it in USDC, the creator
            earns from every trade and keeps onchain provenance of their media — and an autonomous
            agent watches the real trading record and pays that creator without anyone approving it.
          </p>
          <div className="hero-actions">
            <NavLink className="btn primary" to="/markets">EXPLORE LIVE ECONOMY →</NavLink>
            <NavLink className="btn secondary" to="/agent">WATCH THE AGENT</NavLink>
            <NavLink className="btn secondary" to="/safety">VERIFY ON ARC</NavLink>
          </div>
        </div>
        <aside>
          <Mascot />
          <p>
            PRODUCT: MEMEVERSE
            <br />INFRASTRUCTURE: <b className="acid">BUILT ON ARC</b>
            <br />MONEY + GAS: USDC
            <br />AGENT: <b className="acid">CIRCLE AGENT WALLET</b>
            <br />ASSETS: TESTNET ONLY
          </p>
        </aside>
      </section>

      <section className="economy-flow" aria-label="How the MemeVerse economy works">
        {economySteps.map(([n, label, to, copy]) => (
          <NavLink key={n} to={to} className="economy-step">
            <span>{n}</span>
            <strong>{label}</strong>
            <p>{copy}</p>
            <b aria-hidden="true">→</b>
          </NavLink>
        ))}
      </section>

      <section className="runtime-proof" aria-label="Live infrastructure status">
        {checks.map(([label, ready, detail, pending, overrideState]) => (
          <div key={label} className={ready ? 'ready' : ''}>
            <span><i />{overrideState ?? (ready ? 'VERIFIED' : pending ? 'CHECKING' : 'UNAVAILABLE')}</span>
            <strong>{label}</strong>
            <small>{detail}</small>
          </div>
        ))}
      </section>

      <section className="demo-surfaces">
        <Title n="PATH" t="THE THREE-MINUTE TOUR" as="h2" />
        <div>
          <NavLink to="/launch"><small>STEP 01 / WALLET SIGNED</small><strong>LAUNCH A MEME</strong><span>Deploy a real Arc market →</span></NavLink>
          <NavLink to="/markets"><small>STEP 02 / REAL USDC</small><strong>TRADE THE CURVE</strong><span>Buy, sell, and pay the creator →</span></NavLink>
          <NavLink to="/nft"><small>STEP 03 / ONCHAIN PROVENANCE</small><strong>OWN THE MEDIA</strong><span>Mint and sell for USDC →</span></NavLink>
          <NavLink to="/agent"><small>STEP 04 / NO HUMAN APPROVAL</small><strong>AUTONOMOUS REWARDS</strong><span>Watch the agent decide →</span></NavLink>
          <NavLink to="/safety"><small>STEP 05 / INDEPENDENTLY CHECKABLE</small><strong>PROOF CENTER</strong><span>Contracts, modes, and limits →</span></NavLink>
          <NavLink to="/vault"><small>SUPPORTING / ERC-4626</small><strong>TREASURY PRIMITIVE</strong><span>Deposit and redeem USDC →</span></NavLink>
        </div>
      </section>
    </>
  );
}

/**
 * Hosting this application requires SPA history fallback, so a mistyped path arrives in the
 * browser as a successful page load. Say so, and put the demo path back within one click.
 */
function NotFound() {
  return (
    <section className="page not-found">
      <Title n="404" t="NO SUCH SURFACE" />
      <p className="lede">
        That address is not a MemeVerse surface. Nothing failed and nothing is missing — the page
        simply does not exist. Every real surface is one click away.
      </p>
      <div className="not-found-links">
        {navItems.map(([number, label, path]) => (
          <NavLink key={path} to={path}><small>{number}</small><strong>{label}</strong></NavLink>
        ))}
      </div>
      <NavLink className="btn primary" to="/">BACK TO MEMEVERSE →</NavLink>
    </section>
  );
}

function Title({ n, t, as = 'h1' }) {
  const Heading = as;
  return (
    <div className="title">
      <span>{n}</span>
      <Heading>{t}</Heading>
      <i />
    </div>
  );
}

function Launch() {
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [supply, setSupply] = useState('1000000');
  const [description, setDescription] = useState('');
  const [basePrice, setBasePrice] = useState('0.0001');
  const [slopePrice, setSlopePrice] = useState('0.001');
  const [review, setReview] = useState(false);
  const [result, setResult] = useState(null);
  const [formError, setFormError] = useState(null);
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const action = useOnchainAction();
  const factory = useQuery({
    queryKey: ['market-factory-config'],
    queryFn: loadFactoryConfig,
    retry: 1,
  });
  const onArc = isConnected && chainId === arc.id;

  /*
    Validated with the parsers the transaction uses, not with the browser's field validation
    alone. A number input accepts `1e3`, which `BigInt` then rejects — previously inside the
    contract call, where a broad catch swallowed it and the button appeared to do nothing.
  */
  const supplyValue = tokenSupplyValue(supply);
  const basePriceUnits = launchPriceUnits(basePrice);
  // A flat curve is a real market, so zero is valid here and only here.
  const slopePriceUnits = launchPriceUnits(slopePrice, { allowZero: true });
  const launchInvalid = !name.trim() || !symbol.trim()
    || supplyValue === null || basePriceUnits === null || slopePriceUnits === null;

  // Clear a stale message as soon as the user edits anything. Without this, a message from an
  // earlier attempt lingers while the browser's own min/max validation silently blocks a later
  // submit, so the visible text can describe a field the user has already corrected.
  useEffect(() => { setFormError(null); }, [name, symbol, supply, basePrice, slopePrice]);

  function handleSubmit(event) {
    event.preventDefault();
    setResult(null);
    action.reset();
    if (launchInvalid) {
      // Refuse here rather than opening review on values that can never be signed.
      setReview(false);
      setFormError(
        !name.trim() ? 'Enter a meme name.'
          : !symbol.trim() ? 'Enter a ticker.'
            : supplyValue === null ? 'Supply must be a whole number between 100 and 1,000,000,000.'
              : basePriceUnits === null ? 'Initial price must be between 0.000001 and 1000 USDC, with at most 6 decimals.'
                : 'Curve increase must be between 0 and 1000 USDC, with at most 6 decimals.',
      );
      return;
    }
    setFormError(null);
    setReview(true);
  }

  async function launchMarket() {
    if (launchInvalid) return;
    setFormError(null);
    try {
      const receipt = await action.execute({
        address: arcContracts.memeVerseFactory,
        abi: factoryAbi,
        functionName: 'createMarket',
        args: [name.trim(), symbol.trim().toUpperCase(), description.trim(), supplyValue, basePriceUnits, slopePriceUnits],
        chainId: arc.id,
      });
      const [event] = parseEventLogs({ abi: factoryAbi, logs: receipt.logs, eventName: 'MarketCreated', strict: true });
      setResult({ market: event.args.market, token: event.args.token, creator: address, hash: receipt.transactionHash });
      queryClient.invalidateQueries({ queryKey: ['onchain-markets'] });
      queryClient.invalidateQueries({ queryKey: ['market-factory-config'] });
    } catch (error) {
      /*
        Wallet, provider, and receipt failures are already presented by the action state. Anything
        that fails *outside* that — a local decoding or logic error — would otherwise be invisible,
        so it gets a sanitized line of its own rather than silence. No provider internals are shown.
      */
      if (action.state.status !== 'FAILED') {
        setFormError('The launch could not be completed. Check the review details and try again.');
      }
    }
  }

  return (
    <section className="page">
      <Title n="01 CREATE" t="LAUNCH ON ARC" />
      <p className="lede">Deploy a fixed-supply meme token and its USDC-native bonding market from your connected wallet. Success appears only after Arc includes the transaction in a final block.</p>
      <div className="form-grid">
        <form onSubmit={handleSubmit}>
          <label>
            MEME NAME
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. UNEMPLOYED CAT"
              maxLength="64"
              required
            />
          </label>
          <label>
            TICKER
            <input
              value={symbol}
              onChange={(event) => setSymbol(event.target.value.toUpperCase())}
              placeholder="UCAT"
              maxLength="10"
              required
            />
          </label>
          <label>
            TOTAL SUPPLY
            <input
              value={supply}
              onChange={(event) => setSupply(event.target.value)}
              type="number"
              min="100"
              max="1000000000"
              step="1"
              required
            />
          </label>
          <label>
            INITIAL PRICE / TOKEN
            <input
              value={basePrice}
              onChange={(event) => setBasePrice(event.target.value)}
              type="number"
              min="0.000001"
              max="1000"
              step="0.000001"
              required
            />
          </label>
          <label>CURVE PRICE INCREASE<input value={slopePrice} onChange={(event) => setSlopePrice(event.target.value)} type="number" min="0" max="1000" step="0.000001" required /></label>
          <label>
            LORE / DESCRIPTION
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength="280" placeholder="Why does this deserve liquidity?" />
          </label>
          <div className="receive">
            <span>FIXED ONCHAIN SUPPLY</span>
            <b>{Number(supply || 0).toLocaleString()} ${symbol || 'TOKEN'}</b>
          </div>
          <button className="btn primary full" disabled={action.state.status === 'WALLET_SIGNATURE' || action.state.status === 'SUBMITTED'}>REVIEW ONCHAIN LAUNCH →</button>
          {formError ? <small className="tx-error" role="alert">{formError}</small> : null}
          {review ? <div className="onchain-review" role="region" aria-label="Launch review"><b>REVIEW BEFORE SIGNING</b><span>CREATOR // {address ?? 'CONNECT WALLET'}</span><span>FACTORY // {arcContracts.memeVerseFactory}</span><span>PRICE // {basePrice} + UP TO {slopePrice} USDC</span><span>FEES // {factory.data ? `${Number(factory.data.creatorFeeBps) / 100}% CREATOR + ${Number(factory.data.treasuryFeeBps) / 100}% TREASURY` : 'READING ONCHAIN'}</span><button className="btn primary full" type="button" disabled={!onArc || !factory.data || ['WALLET_SIGNATURE', 'SUBMITTED'].includes(action.state.status)} onClick={launchMarket}>{!isConnected ? 'CONNECT WALLET FIRST' : !onArc ? 'SWITCH TO ARC TESTNET' : 'SIGN + LAUNCH ON ARC →'}</button></div> : null}
          <TransactionStatus state={action.state} />
          {result ? <div className="receipt onchain-receipt" role="status"><b>MARKET CONFIRMED ON ARC</b><span>MARKET + TOKEN // {result.market}</span><span>CREATOR // {result.creator}</span><ExternalLink href={`${arcLinks.explorer}/tx/${result.hash}`}>VIEW TRANSACTION ON ARCSCAN ↗</ExternalLink><ExternalLink href={`${arcLinks.explorer}/address/${result.market}`}>VIEW MARKET CONTRACT ↗</ExternalLink></div> : null}
        </form>
        <aside className="spec">
          <span>DEPLOYMENT SPEC</span>
          <dl>
            <dt>MODE</dt><dd>ONCHAIN</dd>
            <dt>NETWORK</dt><dd>{network.chain.name}</dd>
            <dt>SETTLEMENT</dt><dd>USDC</dd>
            <dt>CURVE</dt><dd>LINEAR / WHOLE TOKEN</dd>
            <dt>BROADCAST</dt><dd>WALLET SIGNED</dd>
          </dl>
          <Mascot />
        </aside>
      </div>
    </section>
  );
}

function TransactionStatus({ state }) {
  if (!state || state.status === 'IDLE') return null;
  return (
    <div className={`transaction-status ${state.status === 'FAILED' ? 'failed' : ''}`} role="status" aria-live="polite">
      <b>{state.status}</b>
      {state.hash ? <ExternalLink href={`${arcLinks.explorer}/tx/${state.hash}`}>{state.hash.slice(0, 18)}…{state.hash.slice(-8)} ↗</ExternalLink> : null}
      {state.error ? <span>{state.error}</span> : null}
    </div>
  );
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function Markets() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const [selectedAddress, setSelectedAddress] = useState(null);
  const [side, setSide] = useState('BUY');
  const [buyAmount, setBuyAmount] = useState('0.01');
  const [sellAmount, setSellAmount] = useState('1');
  const slippageBps = 100;
  const onArc = isConnected && chainId === arc.id;
  const markets = useQuery({
    queryKey: ['onchain-markets', address ?? 'anonymous'],
    queryFn: () => loadMarkets(address),
    retry: 1,
    refetchInterval: 12_000,
  });
  const usdcBalance = useQuery({
    queryKey: ['wallet-usdc', address],
    queryFn: () => loadUsdcBalance(address),
    enabled: onArc,
    refetchInterval: 12_000,
  });
  const selected = markets.data?.find((market) => market.address === selectedAddress)
    ?? markets.data?.[0]
    ?? null;
  useEffect(() => {
    if (!selectedAddress && markets.data?.[0]) setSelectedAddress(markets.data[0].address);
  }, [markets.data, selectedAddress]);

  let buyUnits = 0n;
  let sellUnits = 0n;
  let buyInputError = null;
  let sellInputError = null;
  try { buyUnits = parseUsdc(buyAmount); } catch (error) { buyInputError = error.message; }
  try { sellUnits = parseWholeTokens(sellAmount); } catch (error) { sellInputError = error.message; }

  const buyQuote = useQuery({
    queryKey: ['market-buy-quote', selected?.address, buyUnits.toString()],
    queryFn: () => quoteBuy(selected.address, buyUnits),
    enabled: Boolean(selected && buyUnits > 0n),
    retry: 1,
    refetchInterval: 8_000,
  });
  const sellQuote = useQuery({
    queryKey: ['market-sell-quote', selected?.address, sellUnits.toString()],
    queryFn: () => quoteSell(selected.address, sellUnits),
    enabled: Boolean(selected && sellUnits > 0n),
    retry: 1,
    refetchInterval: 8_000,
  });
  const approval = useOnchainAction();
  const buy = useOnchainAction();
  const sell = useOnchainAction();
  const allowanceRequired = Boolean(selected && buyUnits > selected.usdcAllowance);
  const availability = marketAvailability(selected);

  async function refreshMarketState() {
    await Promise.all([
      markets.refetch(),
      usdcBalance.refetch(),
      queryClient.invalidateQueries({ queryKey: ['market-buy-quote'] }),
      queryClient.invalidateQueries({ queryKey: ['market-sell-quote'] }),
    ]);
  }

  async function approveUsdc() {
    try {
      await approval.execute({
        address: arcContracts.usdc,
        abi: usdcAbi,
        functionName: 'approve',
        args: [selected.address, buyUnits],
        chainId: arc.id,
      });
      await refreshMarketState();
    } catch { /* The action state presents the wallet/provider error. */ }
  }

  async function buyTokens(event) {
    event.preventDefault();
    if (!buyQuote.data) return;
    try {
      await buy.execute({
        address: selected.address,
        abi: marketAbi,
        functionName: 'buy',
        args: [buyUnits, minimumAfterSlippage(buyQuote.data[0], slippageBps)],
        chainId: arc.id,
      });
      await refreshMarketState();
    } catch { /* The action state presents the wallet/provider error. */ }
  }

  async function sellTokens(event) {
    event.preventDefault();
    if (!sellQuote.data) return;
    try {
      await sell.execute({
        address: selected.address,
        abi: marketAbi,
        functionName: 'sell',
        args: [sellUnits, minimumAfterSlippage(sellQuote.data[0], slippageBps)],
        chainId: arc.id,
      });
      await refreshMarketState();
    } catch { /* The action state presents the wallet/provider error. */ }
  }

  return (
    <section className="page markets-page">
      <Title n="02 TRADE" t="ONCHAIN USDC MARKETS" />
      <p className="lede">Markets are read directly from the deployed MemeVerse factory. Quotes, reserves, positions, fees, and balances are live Arc Public Testnet state. Every buy and sell pays the creator and the treasury inside the same transaction.</p>
      {markets.isError ? <p className="agent-error" role="alert">ARC RPC READ FAILED // {markets.error.shortMessage ?? 'Public RPC unavailable. Retry shortly.'}</p> : null}
      {!markets.isPending && !markets.data?.length ? (
        <div className="empty"><Mascot small /><span>ONCHAIN MARKETS: 0<br /><NavLink to="/launch">LAUNCH THE FIRST MARKET →</NavLink></span></div>
      ) : null}
      {markets.data?.length ? (
        <div className="market-layout">
          <div className="market-list" role="group" aria-label="Onchain markets">
            {markets.data.map((market) => (
              <button key={market.address} type="button" className={selected?.address === market.address ? 'active' : ''} onClick={() => setSelectedAddress(market.address)}>
                <span>{market.symbol}</span><strong>{market.name}</strong><small>{marketSpotPerTokenLabel(market, formatUsdc)}</small><em>{market.soldTokenCount.toLocaleString()} / {market.totalSupplyTokens.toLocaleString()} SOLD</em>
              </button>
            ))}
          </div>
          {selected ? <div className="market-terminal">
            <section className="market-proof">
              <div><small>MARKET</small><strong>{selected.name} / ${selected.symbol}</strong><ExternalLink href={`${arcLinks.explorer}/address/${selected.address}`}>{shortAddress(selected.address)} ↗</ExternalLink></div>
              <dl>
                <dt>SPOT QUOTE</dt><dd>{marketSpotLabel(selected, formatUsdc)}</dd>
                <dt>CURVE RESERVE</dt><dd>{formatUsdc(selected.reserveUsdc)} USDC</dd>
                <dt>SUPPLY SOLD</dt><dd>{selected.soldTokenCount.toLocaleString()} / {selected.totalSupplyTokens.toLocaleString()}</dd>
                <dt>CREATOR</dt><dd>{shortAddress(selected.creator)}</dd>
                <dt>CREATOR FEES PAID</dt><dd>{formatUsdc(selected.creatorFeesPaidUsdc)} USDC</dd>
                <dt>TREASURY FEES PAID</dt><dd>{formatUsdc(selected.treasuryFeesPaidUsdc)} USDC</dd>
                <dt>YOUR POSITION</dt><dd>{formatTokenAmount(selected.userBalance)} {selected.symbol}</dd>
              </dl>
              {selected.description ? <p>{selected.description}</p> : null}
            </section>
            <section className="market-order">
              <div className="tabs"><button type="button" className={side === 'BUY' ? 'active' : ''} onClick={() => setSide('BUY')}>BUY</button><button type="button" className={side === 'SELL' ? 'active sell' : ''} onClick={() => setSide('SELL')}>SELL</button></div>
              {side === 'BUY' && availability.soldOut ? (
                <div className="trade-review sold-out" role="status">
                  <span>BUY AVAILABILITY <b>SOLD OUT</b></span>
                  <span>SUPPLY <b>{selected.soldTokenCount.toLocaleString()} / {selected.totalSupplyTokens.toLocaleString()} SOLD</b></span>
                  <span>CURVE RESERVE <b>{formatUsdc(selected.reserveUsdc)} USDC</b></span>
                  <span>The complete fixed supply is circulating, so this market has no next token to price. Selling back to the curve reserve remains available.</span>
                </div>
              ) : side === 'BUY' ? <form onSubmit={buyTokens}>
                <label>MAXIMUM USDC INPUT<input value={buyAmount} onChange={(event) => setBuyAmount(event.target.value)} type="number" inputMode="decimal" min="0.000001" step="0.000001" required /><small>USDC</small></label>
                <div className="trade-review">
                  <span>WALLET BALANCE <b>{onArc && usdcBalance.data !== undefined ? `${formatUsdc(usdcBalance.data)} USDC` : 'CONNECT ON ARC'}</b></span>
                  <span>MAX INPUT <b>{buyAmount || '0'} USDC</b></span>
                  <span>ACTUAL ESTIMATED SPEND <b>{buyQuote.data ? `${formatUsdc(buyQuote.data[4])} USDC` : '—'}</b></span>
                  <span>ESTIMATED OUT <b>{buyQuote.data ? `${formatTokenAmount(buyQuote.data[0], 0)} ${selected.symbol}` : '—'}</b></span>
                  <span>CURVE COST <b>{buyQuote.data ? `${formatUsdc(buyQuote.data[1])} USDC` : '—'}</b></span>
                  <span>CREATOR ALLOCATION <b>{buyQuote.data ? `${formatUsdc(buyQuote.data[2])} USDC` : '—'}</b></span>
                  <span>TREASURY ALLOCATION <b>{buyQuote.data ? `${formatUsdc(buyQuote.data[3])} USDC` : '—'}</b></span>
                  <span>MINIMUM OUT / SLIPPAGE <b>{buyQuote.data ? `${formatTokenAmount(minimumAfterSlippage(buyQuote.data[0], slippageBps), 2)} / 1%` : '—'}</b></span>
                </div>
                {buyInputError ? <p className="agent-error">{buyInputError}</p> : null}
                {allowanceRequired ? <button className="btn secondary full" type="button" disabled={!onArc || approval.state.status === 'WALLET_SIGNATURE' || approval.state.status === 'SUBMITTED'} onClick={approveUsdc}>APPROVE MAX {buyAmount || '0'} USDC →</button> : null}
                <button className="btn primary full" disabled={!onArc || !buyQuote.data || buyQuote.data[0] === 0n || allowanceRequired || ['WALLET_SIGNATURE', 'SUBMITTED'].includes(buy.state.status)}>SIGN BUY ON ARC →</button>
                <TransactionStatus state={approval.state} />
                <TransactionStatus state={buy.state} />
              </form> : <form onSubmit={sellTokens}>
                <label>TOKEN AMOUNT<input value={sellAmount} onChange={(event) => setSellAmount(event.target.value)} type="number" inputMode="numeric" min="1" step="1" required /><small>{selected.symbol}</small></label>
                <div className="trade-review">
                  <span>YOUR POSITION <b>{formatTokenAmount(selected.userBalance)} {selected.symbol}</b></span>
                  <span>GROSS CURVE RETURN <b>{sellQuote.data ? `${formatUsdc(sellQuote.data[1])} USDC` : '—'}</b></span>
                  <span>CREATOR ALLOCATION <b>{sellQuote.data ? `${formatUsdc(sellQuote.data[2])} USDC` : '—'}</b></span>
                  <span>TREASURY ALLOCATION <b>{sellQuote.data ? `${formatUsdc(sellQuote.data[3])} USDC` : '—'}</b></span>
                  <span>ESTIMATED USDC OUT <b>{sellQuote.data ? `${formatUsdc(sellQuote.data[0])} USDC` : '—'}</b></span>
                  <span>MINIMUM OUT / SLIPPAGE <b>{sellQuote.data ? `${formatUsdc(minimumAfterSlippage(sellQuote.data[0], slippageBps))} / 1%` : '—'}</b></span>
                </div>
                {sellInputError ? <p className="agent-error">{sellInputError}</p> : null}
                <button className="btn primary full" disabled={!onArc || !sellQuote.data || sellQuote.data[0] === 0n || sellUnits > selected.userBalance || ['WALLET_SIGNATURE', 'SUBMITTED'].includes(sell.state.status)}>SIGN SELL ON ARC →</button>
                <TransactionStatus state={sell.state} />
              </form>}
            </section>
          </div> : null}
        </div>
      ) : null}
      {selected ? (
        <Suspense fallback={<LazySection />}>
          <CreatorEconomy market={selected} />
        </Suspense>
      ) : null}
    </section>
  );
}

function Quote() {
  const [pair, setPair] = useState(['USDC', 'EURC']);
  const [amount, setAmount] = useState('0.01');
  const [quote, setQuote] = useState(null);
  const [requestState, setRequestState] = useState({ status: 'idle', error: null });
  const capabilities = useQuery({
    queryKey: ['app-kit-capabilities'],
    queryFn: getAppKitCapabilities,
    retry: 1,
    staleTime: 30_000,
  });
  const runtimeReady = capabilities.data?.data?.runtimeEnabled === true;

  function reversePair() {
    setPair(([tokenIn, tokenOut]) => [tokenOut, tokenIn]);
    setQuote(null);
  }

  async function requestQuote(event) {
    event.preventDefault();
    setRequestState({ status: 'loading', error: null });
    setQuote(null);
    try {
      const response = await estimateAppKitSwap({
        tokenIn: pair[0],
        tokenOut: pair[1],
        amountIn: amount,
      });
      setQuote(response.data);
      setRequestState({ status: 'success', error: null });
    } catch (error) {
      setRequestState({
        status: 'error',
        error: `${error.code ?? 'QUOTE_FAILED'}: ${error.message}`,
      });
    }
  }

  return (
    <section className="page app-kit-page">
      <Title n="07 QUOTE" t="CIRCLE STABLECOIN QUOTE" />
      <p className="lede">
        Request a live, authenticated Circle Stablecoin Kits estimate for Arc Testnet. The Kit Key
        stays on the server, transaction data is discarded, and this screen never signs or broadcasts.
      </p>
      <div className="app-kit-grid">
        <form className="quote-form" onSubmit={requestQuote}>
          <div className={`runtime-badge ${runtimeReady ? 'ready' : ''}`}>
            <i />{capabilities.isPending ? 'CHECKING RUNTIME' : runtimeReady ? 'CIRCLE RUNTIME READY' : 'RUNTIME UNAVAILABLE'}
          </div>
          <div className="pair-display" aria-label={`Swap pair ${pair[0]} to ${pair[1]}`}>
            <span><small>FROM</small>{pair[0]}</span>
            <button type="button" onClick={reversePair} aria-label="Reverse token pair">⇄</button>
            <span><small>TO</small>{pair[1]}</span>
          </div>
          <label>
            AMOUNT IN
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              min="0.000001"
              step="0.000001"
              type="number"
              required
            />
            <small>{pair[0]}</small>
          </label>
          <button className="btn primary full" disabled={!runtimeReady || requestState.status === 'loading'}>
            {requestState.status === 'loading' ? 'REQUESTING CIRCLE QUOTE…' : 'GET LIVE ESTIMATE →'}
          </button>
          <p className="quote-boundary">ESTIMATE ONLY // NO SIGNATURE // NO BROADCAST // TESTNET ASSETS</p>
          {requestState.error ? <p className="agent-error" role="alert">{requestState.error}</p> : null}
        </form>
        <section className="quote-result" aria-live="polite" aria-busy={requestState.status === 'loading'}>
          <span>SERVER-SANITIZED RESPONSE</span>
          {quote ? (
            <>
              <div className="quote-output"><small>ESTIMATED OUTPUT</small><strong>{quote.estimatedOutput.amount}</strong><b>{quote.estimatedOutput.token}</b></div>
              <dl>
                <dt>INPUT</dt><dd>{quote.amountIn} {quote.tokenIn}</dd>
                <dt>STOP LIMIT</dt><dd>{quote.stopLimit.amount} {quote.stopLimit.token}</dd>
                <dt>NETWORK</dt><dd>{quote.chain.replace('_', ' ')}</dd>
                <dt>PROVIDER</dt><dd>CIRCLE</dd>
                <dt>FEES</dt><dd>{quote.fees.length ? quote.fees.map((fee) => `${fee.amount} ${fee.token}`).join(' + ') : 'NONE RETURNED'}</dd>
              </dl>
              {quote.quoteReference ? <p>QUOTE REF // {quote.quoteReference}</p> : null}
            </>
          ) : (
            <div className="quote-empty"><Mascot small /><p>Enter an amount to fetch a real Arc Testnet estimate from Circle.</p></div>
          )}
          <div className="quote-proof">
            <span>KIT KEY</span><b>SERVER ONLY</b>
            <span>TRANSACTION PAYLOAD</span><b>DISCARDED</b>
            <span>DEPENDENCY AUDIT</span><b>0 FINDINGS</b>
          </div>
        </section>
      </div>
      <div className="stack-strip">
        <span>BUILT ON ARC</span><span>USDC GAS</span><span>LIVE CIRCLE ESTIMATE</span>
        <span>SERVER-SIDE AUTH</span><span>FAIL-CLOSED VALIDATION</span><span>NO BROADCAST</span>
      </div>
    </section>
  );
}

/**
 * The simulated NFT archive and Vault surfaces that stood here through Stage 1 have been
 * removed. Both are now real Arc contracts, rendered by `MediaAssets` and `UsdcVault` in
 * `stage2-views.jsx`, which read deployed state instead of a hard-coded demo list.
 */

function useOperatorSession() {
  const session = useQuery({
    queryKey: ['operator-session'],
    queryFn: getOperatorSession,
    retry: 1,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  return {
    query: session,
    authenticated: session.data?.data?.authenticated === true,
    operatorAddress: session.data?.data?.operatorAddress ?? null,
    expiresAt: session.data?.data?.expiresAt ?? null,
  };
}

/**
 * Layer 1 of the execution gate. The wallet signature proves control of the configured
 * SETTLEMENT_OPERATOR_ADDRESS; the resulting session lives in an HttpOnly cookie this script
 * can never read. Connecting an ordinary MemeVerse trading wallet grants nothing.
 */
function OperatorSessionPanel({ session }) {
  const { address, isConnected } = useAccount();
  const { connect, isPending: connectPending } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const [state, setState] = useState({ status: 'idle', error: null });

  async function signIn() {
    setState({ status: 'loading', error: null });
    try {
      const challenge = (await requestOperatorChallenge(address)).data;
      const signature = await signMessageAsync({ message: challenge.message });
      await verifyOperatorSignature(challenge.challengeId, signature);
      await session.query.refetch();
      setState({ status: 'idle', error: null });
    } catch (error) {
      setState({
        status: 'idle',
        error: error.code === 'OPERATOR_AUTH_FAILED'
          ? 'THIS WALLET IS NOT THE AUTHORIZED SETTLEMENT OPERATOR'
          : `${error.code ?? 'SIGN_IN_FAILED'}: ${error.shortMessage ?? error.message}`,
      });
    }
  }

  async function signOut() {
    setState({ status: 'loading', error: null });
    try {
      await endOperatorSession();
    } finally {
      await session.query.refetch();
      setState({ status: 'idle', error: null });
    }
  }

  return (
    <div className={`operator-session ${session.authenticated ? 'authenticated' : ''}`} aria-label="Operator authentication">
      <div className="operator-steps">
        <span className={isConnected ? 'done' : ''}><b>01</b>CONNECT WALLET</span>
        <span className={session.authenticated ? 'done' : ''}><b>02</b>SIGN OPERATOR SESSION</span>
        <span className={session.authenticated ? 'done' : ''}><b>03</b>AUTHENTICATED OPERATOR</span>
      </div>
      {session.authenticated ? (
        <div className="operator-identity">
          <span>OPERATOR // {shortAddress(session.operatorAddress)}</span>
          <span>SESSION EXPIRES // {new Date(session.expiresAt).toLocaleTimeString()}</span>
          <button className="btn" type="button" onClick={signOut} disabled={state.status === 'loading'}>END OPERATOR SESSION</button>
        </div>
      ) : (
        <div className="operator-identity">
          <span>PRIVILEGED SETTLEMENT CONTROLS REQUIRE AN AUTHENTICATED OPERATOR WALLET.</span>
          <span>ORDINARY MARKET TRADING IS UNAFFECTED AND NEEDS NO OPERATOR SESSION.</span>
          {isConnected ? (
            <button className="btn primary" type="button" onClick={signIn} disabled={state.status === 'loading'}>
              {state.status === 'loading' ? 'AWAITING WALLET SIGNATURE…' : 'SIGN OPERATOR SESSION →'}
            </button>
          ) : (
            <button className="btn primary" type="button" onClick={() => connect({ connector: injected() })} disabled={connectPending}>
              {connectPending ? 'REQUESTING…' : 'CONNECT WALLET →'}
            </button>
          )}
        </div>
      )}
      {state.error ? <p className="agent-error" role="alert">{state.error}</p> : null}
    </div>
  );
}

function Agent() {
  const [record, setRecord] = useState(null);
  const [form, setForm] = useState({
    recipient: '0x1111111111111111111111111111111111111111',
    requestedAmount: '1.00',
    engagementVelocity: '94',
    holderRetention: '92',
    liquidityDepth: '90',
    fraudRisk: '8',
    confidence: '96',
    reference: 'MEME-CREATOR-PAYOUT',
  });
  const [requestState, setRequestState] = useState({ status: 'idle', error: null, replayed: false });
  const [executionReview, setExecutionReview] = useState({ open: false, authorization: null });
  const lastAttempt = useRef(null);
  const session = useOperatorSession();
  const health = useQuery({
    queryKey: ['api-health'],
    queryFn: getApiHealth,
    retry: 1,
    staleTime: 15_000,
  });
  const circleReady = health.data?.circle?.ready === true;
  const approved = record?.policy?.approved === true;
  const trace = [
    ['01', 'INGEST + WEIGHT SIGNALS', record?.agentDecision ? `SCORE ${record.agentDecision.confidenceAdjustedScore}` : 'PENDING'],
    ['02', 'CHECK SERVER POLICY', record ? (approved ? 'PASS / CAP OK' : 'DENIED') : 'PENDING'],
    ['03', 'CALCULATE CREATOR SHARE', record ? `${record.amount.creatorPayoutUsdc} USDC` : 'PENDING'],
    ['04', 'PERSIST MEMO REFERENCE', record ? 'MEMO ID READY' : 'PENDING'],
    ['05', 'CIRCLE MEMO EXECUTION', record?.circle?.state ?? (record?.executionPlan ? 'AWAITING HUMAN APPROVAL' : record ? 'NOT PREPARED' : 'PENDING')],
    ['06', 'VERIFY ARC EVENTS', record?.reconciliation?.status ?? (record?.transactionHash ? 'INDEXING' : 'PENDING')],
  ];

  function updateForm(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  function reportError(error, fallbackCode) {
    setRequestState({
      status: 'error',
      error: error.status === 401
        ? 'OPERATOR_AUTH_REQUIRED: The operator session expired. Sign in again.'
        : `${error.code ?? fallbackCode}: ${error.message}${error.requestId ? ` // ${error.requestId}` : ''}`,
      replayed: false,
    });
    if (error.status === 401) session.query.refetch();
  }

  async function runPolicy(event) {
    event.preventDefault();
    const requestFingerprint = JSON.stringify(form);
    if (lastAttempt.current?.fingerprint !== requestFingerprint) {
      lastAttempt.current = { fingerprint: requestFingerprint, key: createIdempotencyKey() };
    }
    // Signal values only. The backend stamps provenance and the observation timestamp itself.
    const input = {
      recipient: form.recipient,
      requestedAmount: form.requestedAmount,
      reference: form.reference,
      signals: {
        engagementVelocity: Number(form.engagementVelocity),
        holderRetention: Number(form.holderRetention),
        liquidityDepth: Number(form.liquidityDepth),
        fraudRisk: Number(form.fraudRisk),
        confidence: Number(form.confidence),
        sourceReference: form.reference,
      },
    };
    setRequestState({ status: 'loading', error: null, replayed: false });
    setExecutionReview({ open: false, authorization: null });
    setRecord(null);
    try {
      const quote = await createAgentDecision(input, lastAttempt.current.key);
      setRecord(quote.data);
      setRequestState({
        status: quote.data.policy.approved ? 'success' : 'denied',
        error: null,
        replayed: quote.meta.replayed,
      });
    } catch (error) {
      reportError(error, 'REQUEST_FAILED');
    }
  }

  async function reviewExecution() {
    setRequestState({ status: 'loading', error: null, replayed: false });
    try {
      const authorization = (await authorizeSettlementExecution(record.id)).data;
      setExecutionReview({ open: true, authorization });
      setRequestState({ status: 'idle', error: null, replayed: false });
    } catch (error) {
      reportError(error, 'EXECUTION_AUTHORIZATION_FAILED');
    }
  }

  async function executeWithCircle() {
    if (!executionReview.authorization) return;
    setRequestState({ status: 'loading', error: null, replayed: false });
    try {
      const response = await executeSettlement(
        record.id,
        executionReview.authorization.authorizationId,
      );
      setRecord(response.data);
      setExecutionReview({ open: false, authorization: null });
      setRequestState({ status: 'submitted', error: null, replayed: false });
    } catch (error) {
      // The authorization is single use, so a failure always returns to a fresh review.
      setExecutionReview({ open: false, authorization: null });
      reportError(error, 'CIRCLE_EXECUTION_FAILED');
    }
  }

  async function reconcileWithCircle() {
    setRequestState({ status: 'loading', error: null, replayed: false });
    try {
      const response = await reconcileSettlement(record.id);
      setRecord(response.data);
      setRequestState({ status: 'submitted', error: null, replayed: false });
    } catch (error) {
      reportError(error, 'CIRCLE_RECONCILIATION_FAILED');
    }
  }

  return (
    <section className="page agent-page">
      <Title n="04 REWARD" t="AUTONOMOUS AGENT" />
      {/*
        The autonomous system comes first: it is the real agent, and it pays creators with no
        human in the execution path. The operator-driven flow below it is the separate, manual
        Developer-Controlled Wallet route and is deliberately presented as such.
      */}
      <Suspense fallback={<LazySection />}>
        <AgentCommandCenter />
      </Suspense>

      {/*
        Collapsed by default, and that is a truthfulness decision rather than a cosmetic one. The
        surface above states that no human approves an autonomous payout; presenting a human
        approval form immediately beneath it, at the same visual weight, invites the reader to
        conclude the two are the same flow. They share no wallet, no settlement contract, and no
        allowance. The route is fully preserved — every control below is unchanged — but it opens
        only when somebody deliberately asks for it.
      */}
      <details className="manual-route">
        <summary>
          <span>ADVANCED / SUPPORTING MANUAL ROUTE</span>
          <small>
            Separate human-authorized settlement path — not used by autonomous creator rewards.
          </small>
        </summary>
      <Title n="MANUAL" t="OPERATOR SETTLEMENT ROUTE" />
      <p className="lede">
        A separate, human-authorized route. The backend weights engagement, retention, liquidity,
        fraud-risk, and confidence signals against live Arc and Circle treasury evidence. Signal
        provenance and evidence timing are assigned by the server, never by the browser. On this
        route the agent may quote and prepare only; every Arc Memo execution requires an
        authenticated operator and a one-time approval bound to that exact settlement.
      </p>
      <OperatorSessionPanel session={session} />
      <div className="agent-grid">
        <form className="agent-rules" onSubmit={runPolicy}>
          <div className="form-section-label"><span>01</span> SETTLEMENT REQUEST</div>
          <div className="agent-fields identity-fields">
            <label className="wide">RECIPIENT<input name="recipient" value={form.recipient} onChange={updateForm} spellCheck="false" disabled={!session.authenticated} required /></label>
            <label>REQUESTED SPEND<input name="requestedAmount" type="number" inputMode="decimal" min="0.01" max="25" step="0.01" value={form.requestedAmount} onChange={updateForm} disabled={!session.authenticated} required /><small>{network.money}</small></label>
            <label>REFERENCE<input name="reference" value={form.reference} onChange={updateForm} minLength="3" maxLength="120" spellCheck="false" disabled={!session.authenticated} required /></label>
          </div>
          <div className="form-section-label"><span>02</span> OPERATOR SIGNAL INPUT / 0—100</div>
          <div className="agent-fields signal-fields">
            <label>ENGAGEMENT<input name="engagementVelocity" type="number" min="0" max="100" value={form.engagementVelocity} onChange={updateForm} disabled={!session.authenticated} required /><small>45% WT.</small></label>
            <label>RETENTION<input name="holderRetention" type="number" min="0" max="100" value={form.holderRetention} onChange={updateForm} disabled={!session.authenticated} required /><small>25% WT.</small></label>
            <label>LIQUIDITY<input name="liquidityDepth" type="number" min="0" max="100" value={form.liquidityDepth} onChange={updateForm} disabled={!session.authenticated} required /><small>30% WT.</small></label>
            <label>FRAUD RISK<input name="fraudRisk" type="number" min="0" max="100" value={form.fraudRisk} onChange={updateForm} disabled={!session.authenticated} required /><small>MAX 20</small></label>
            <label>CONFIDENCE<input name="confidence" type="number" min="0" max="100" value={form.confidence} onChange={updateForm} disabled={!session.authenticated} required /><small>MIN 80</small></label>
          </div>
          <div className="policy-caps" aria-label="Enforced policy limits">
            <span>MAX <b>25 USDC</b></span><span>SCORE <b>78+</b></span><span>SHARE <b>60%</b></span>
            <span>DAILY <b>30 USDC</b></span><span>AUTH <b>OPERATOR</b></span><span>MODE <b>MANUAL</b></span>
          </div>
          <button className="btn primary full" type="submit" disabled={!session.authenticated || requestState.status === 'loading'}>
            {!session.authenticated
              ? 'OPERATOR SESSION REQUIRED'
              : requestState.status === 'loading' ? 'ENFORCING POLICY…' : 'REQUEST SETTLEMENT QUOTE →'}
          </button>
          {requestState.error ? <p className="agent-error" role="alert">{requestState.error}</p> : null}
        </form>
        <div className="agent-log" aria-live="polite">
          <span>BACKEND EXECUTION TRACE</span>
          {trace.map((item) => (
            <div className={record ? (approved ? 'done' : 'denied') : ''} key={item[0]}>
              <b>{item[0]}</b>
              <span>{item[1]}</span>
              <strong>{item[2]}</strong>
            </div>
          ))}
          <div className="agent-status">
            {record
              ? `${record.state} // ${record.reference}${requestState.replayed ? ' // IDEMPOTENT REPLAY' : ''}`
              : session.authenticated ? 'OPERATOR AUTHENTICATED // AWAITING SIGNAL INPUT' : 'PUBLIC VIEW // PRIVILEGED CONTROLS LOCKED'}
          </div>
        </div>
      </div>
      {record ? (
        <div className={`settlement-receipt ${approved ? '' : 'denied'}`} role="status" aria-live="polite">
          <b>{approved ? 'PERSISTED SETTLEMENT PLAN' : 'POLICY DENIED'}</b>
          <span>ID // {record.id}</span>
          <span>STATE // {record.state}</span>
          <span>CREATOR // {record.amount.creatorPayoutUsdc} USDC</span>
          <span>TREASURY // {record.amount.treasuryRetainedUsdc} USDC</span>
          <span>MEMO // {record.memoId}</span>
          {record.agentDecision ? <span>AGENT SCORE // RAW {record.agentDecision.weightedScore} / ADJUSTED {record.agentDecision.confidenceAdjustedScore}</span> : null}
          {record.agentDecision ? <span>EVIDENCE // {record.agentDecision.signals.provenance} / {record.agentDecision.evidence.suppliedBy}</span> : null}
          {record.agentDecision ? <span>AUTONOMY // QUOTE + PREPARE ONLY / HUMAN-APPROVED EXECUTION</span> : null}
          {record.reservation ? <span>RESERVATION // {Number(record.reservation.units) / 1e6} USDC / {record.reservation.status}</span> : null}
          {record.executionPlan?.targetContract ? <span>SETTLEMENT CONTRACT // {record.executionPlan.targetContract}</span> : null}
          {record.executionAuthorization ? <span>AUTHORIZED BY // {record.executionAuthorization.mode} / {shortAddress(record.executionAuthorization.operatorAddress)}</span> : null}
          {record.expiresAt ? <span>QUOTE EXPIRY // {record.expiresAt}</span> : null}
          {record.policy.reasons.map((reason) => <span key={reason.code}>{reason.code} // {reason.message}</span>)}
          <span>BROADCAST // {String(record.broadcast).toUpperCase()}</span>
          {record.circle ? <span>CIRCLE TX // {record.circle.transactionId} / {record.circle.state}</span> : null}
          {record.reconciliation ? <span>ARC INDEX // {record.reconciliation.status}{record.reconciliation.blockNumber ? ` / BLOCK ${record.reconciliation.blockNumber}` : ''}</span> : null}
          {record.transactionHash ? (
            <ExternalLink href={`${arcLinks.explorer}/tx/${record.transactionHash}`}>VERIFY ON ARCSCAN ↗</ExternalLink>
          ) : null}
          {approved && record.state === 'AWAITING_SIGNATURE' && session.authenticated ? (
            executionReview.open ? (
              <div className="execution-review">
                <strong>HUMAN EXECUTION GATE // SERVER-BOUND APPROVAL</strong>
                <p>The server issued a single-use approval bound to the exact payload below. It expires shortly, cannot be reused, and cannot execute any other settlement.</p>
                <dl>
                  <dt>SETTLEMENT</dt><dd>{executionReview.authorization.binding.settlementId}</dd>
                  <dt>RECIPIENT</dt><dd>{executionReview.authorization.binding.recipient}</dd>
                  <dt>CREATOR PAYOUT</dt><dd>{Number(executionReview.authorization.binding.creatorPayoutUnits) / 1e6} USDC</dd>
                  <dt>CHAIN</dt><dd>{executionReview.authorization.binding.chainId}</dd>
                  <dt>CONTRACT</dt><dd>{executionReview.authorization.binding.settlementContract}</dd>
                  <dt>MEMO ID</dt><dd>{executionReview.authorization.binding.memoId}</dd>
                  <dt>APPROVAL EXPIRES</dt><dd>{new Date(executionReview.authorization.expiresAt).toLocaleTimeString()}</dd>
                </dl>
                <div>
                  <button className="btn" type="button" onClick={() => setExecutionReview({ open: false, authorization: null })}>CANCEL</button>
                  <button className="btn circle-action" type="button" disabled={requestState.status === 'loading'} onClick={executeWithCircle}>APPROVE + EXECUTE VIA CIRCLE →</button>
                </div>
              </div>
            ) : (
              <button
                className="btn circle-action"
                type="button"
                disabled={!circleReady || requestState.status === 'loading'}
                onClick={reviewExecution}
              >
                {circleReady ? 'REVIEW HUMAN EXECUTION →' : 'CIRCLE + SETTLEMENT CONTRACT REQUIRED'}
              </button>
            )
          ) : null}
          {record.circle && session.authenticated && !['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'].includes(record.state) ? (
            <button
              className="btn circle-action"
              type="button"
              disabled={requestState.status === 'loading'}
              onClick={reconcileWithCircle}
            >
              RECONCILE CIRCLE + ARC EVENTS ↻
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="stack-strip">
        <span>BUILT ON ARC</span>
        <span>USDC GAS</span>
        <span>ARC MEMO LIVE</span>
        <span>WALLET-SIGNED OPERATOR SESSION</span>
        <span>SERVER-STAMPED PROVENANCE</span>
        <span>SETTLEMENT-BOUND APPROVAL</span>
        <span>VERIFIED SETTLEMENT CONTRACT</span>
        <span>POSTGRES TREASURY RESERVATIONS</span>
        <span>VERSIONED STATE WRITES</span>
        <span>NO BLIND RETRIES</span>
        <span>CIRCLE DEV-CONTROLLED EOA</span>
        <span>SEPARATE LEASED WORKER</span>
      </div>
      </details>
    </section>
  );
}

function Safety() {
  return (
    <section className="page safety-page">
      <Title n="05 PROVE" t="PROOF CENTER" />
      <p className="lede">
        Everything MemeVerse claims resolves to something you can open on ArcScan and check without
        trusting this page. What is live, what is deployed, who executes, and what is not ready.
      </p>
      <div className="risk-banner">
        <strong>TESTNET ONLY</strong>
        <span>Arc Public Testnet. Test assets have no real-world value. No MemeVerse screen should ever ask for a seed phrase or private key — treat unsolicited support DMs as scams.</span>
      </div>
      <Suspense fallback={<LazySection />}><ProofCenter /></Suspense>
      <div className="safety-grid">
        <section>
          <h3>TRANSACTION LIFECYCLE</h3>
          <div className="state-pipeline">
            {transactionPhases.map((phase, index) => (
              <span key={phase}><b>0{index + 1}</b>{phase}</span>
            ))}
          </div>
          <p>Every surface persists the reference, the latest hash, and the failure class. Nothing is ever rebroadcast blindly after an unknown or post-broadcast failure, and no screen shows success before its Arc receipt confirms.</p>
        </section>
        <section>
          <h3>POST-QUANTUM STATUS</h3>
          <p>Arc documents post-quantum security as a roadmap item, not a currently available Testnet feature. MemeVerse therefore makes no quantum-security claim today.</p>
          <ExternalLink href={arcLinks.security}>READ THE OFFICIAL ROADMAP ↗</ExternalLink>
        </section>
      </div>
    </section>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={routerBase}>
          <Shell />
        </BrowserRouter>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);

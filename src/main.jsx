import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  WagmiProvider,
  createConfig,
  http,
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useSwitchChain,
} from 'wagmi';
import { injected } from 'wagmi/connectors';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  ARC_RPC_URL,
  arc,
  arcCapabilities,
  arcContracts,
  arcLinks,
} from './arc';
import {
  createReferenceId,
  createSimulationRecord,
  transactionPhases,
} from './transaction-lifecycle';
import {
  createIdempotencyKey,
  createAgentDecision,
  estimateAppKitSwap,
  executeSettlement,
  getAppKitCapabilities,
  getApiHealth,
  reconcileSettlement,
} from './api';
import './styles.css';

const config = createConfig({
  chains: [arc],
  connectors: [injected()],
  transports: { [arc.id]: http(ARC_RPC_URL) },
});
const queryClient = new QueryClient();
const routerBase =
  import.meta.env.BASE_URL === '/'
    ? undefined
    : import.meta.env.BASE_URL.replace(/\/$/, '');
const RouterContext = React.createContext(null);

function BrowserRouter({ basename = '', children }) {
  const routePath = React.useCallback(() => {
    const withoutBase = basename && window.location.pathname.startsWith(basename)
      ? window.location.pathname.slice(basename.length)
      : window.location.pathname;
    return withoutBase || '/';
  }, [basename]);
  const [pathname, setPathname] = useState(routePath);

  React.useEffect(() => {
    const onPopState = () => setPathname(routePath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [routePath]);

  function navigate(to) {
    const href = `${basename}${to === '/' ? '/' : to}`;
    window.history.pushState({}, '', href);
    setPathname(to);
  }

  return <RouterContext.Provider value={{ basename, pathname, navigate }}>{children}</RouterContext.Provider>;
}

function NavLink({ to, className = '', children }) {
  const router = React.useContext(RouterContext);
  const active = router.pathname === to;
  const href = `${router.basename}${to === '/' ? '/' : to}`;

  function onClick(event) {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      router.navigate(to);
    }
  }

  return <a href={href} className={`${className}${active ? ' active' : ''}`.trim()} onClick={onClick}>{children}</a>;
}

function Route() {
  return null;
}

function Routes({ children }) {
  const { pathname } = React.useContext(RouterContext);
  const route = React.Children.toArray(children).find((child) => child.props.path === pathname);
  return route?.props.element ?? null;
}

const network = {
  chain: arc,
  money: 'USDC',
};
const coins = [
  ['PEPE.exe', 'PEPX', '$0.004218', '+18.4'],
  ['GIGA BRAIN', 'GBRN', '$0.08801', '+9.7'],
  ['RUG PROOF', 'RUGP', '$0.00091', '-4.2'],
  ['404 DOG', 'DOG4', '$0.02024', '+6.9'],
];
const nfts = [
  ['NO SIGNAL #033', '120 USDC'],
  ['BASED SPECIMEN #19', '80 USDC'],
  ['TERMINAL FROG #808', '210 USDC'],
];

function ExternalLink({ href, children, className = '' }) {
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer">
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
  return (
    <div className="marquee" aria-label="Simulated market ticker">
      <div>
        {[...coins, ...coins].map((coin, index) => (
          <span key={`${coin[1]}-${index}`}>
            {coin[1]} <b>{coin[2]}</b>{' '}
            <em className={coin[3][0] === '-' ? 'down' : 'up'}>
              {coin[3]}% DEMO
            </em>
          </span>
        ))}
      </div>
    </div>
  );
}

function Wallet() {
  const { address, isConnected } = useAccount();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  return isConnected ? (
    <button className="wallet" type="button" onClick={() => disconnect()} aria-label={`Disconnect testnet wallet ${address}`}>
      <i />TESTNET {address.slice(0, 6)}…{address.slice(-4)}
    </button>
  ) : (
    <button className="wallet" type="button" onClick={() => connect({ connector: injected() })}>
      {isPending ? 'REQUESTING…' : 'CONNECT TESTNET WALLET'}
    </button>
  );
}

function NetworkStatus() {
  const chainId = useChainId();
  const { isConnected } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const onArc = isConnected && chainId === arc.id;

  return (
    <div className="network-switch" aria-label="Arc Testnet connection status">
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

function Shell() {
  const navItems = [
    ['01', 'AGENT', '/agent'],
    ['02', 'APP KIT', '/trade'],
    ['03', 'LABS', '/launch'],
    ['04', 'PROOF', '/safety'],
  ];

  return (
    <>
      <a className="skip-link" href="#main-content">SKIP TO PRODUCT</a>
      <Marquee />
      <div className="network-bar">
        <span>PUBLIC TESTNET // NO REAL ASSETS</span>
        <div className="network-center">
          <BackendStatus />
          <NetworkStatus />
        </div>
        <ExternalLink href={arcLinks.status}>NETWORK STATUS ↗</ExternalLink>
      </div>
      <div className="testnet-banner">
        PUBLIC TESTNET — LIVE QUOTES, TEST ASSETS — HUMAN APPROVAL REQUIRED FOR EXECUTION
      </div>
      <header>
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
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/launch" element={<Launch />} />
          <Route path="/trade" element={<Trade />} />
          <Route path="/nft" element={<NFT />} />
          <Route path="/vault" element={<Vault />} />
          <Route path="/agent" element={<Agent />} />
          <Route path="/safety" element={<Safety />} />
        </Routes>
      </main>
      <footer>
        <span>MEMEVERSE © 2026</span>
        <span>{network.chain.name.toUpperCase()} // CHAIN {network.chain.id}</span>
        <ExternalLink href={arcLinks.docs}>BUILT ON ARC // OFFICIAL DOCS ↗</ExternalLink>
      </footer>
    </>
  );
}

function Home() {
  const health = useQuery({
    queryKey: ['api-health'],
    queryFn: getApiHealth,
    retry: 1,
    refetchInterval: 30_000,
  });
  const live = health.data?.status === 'ok';
  const checks = [
    ['ARC RPC', health.data?.arc?.status === 'verified', health.data?.arc?.blockNumber ? `BLOCK ${health.data.arc.blockNumber}` : 'VERIFYING'],
    ['POSTGRES', health.data?.persistence?.ready === true, 'RESERVATIONS READY'],
    ['CIRCLE WALLET', health.data?.circle?.configured === true, 'DEV-CONTROLLED'],
    ['APP KIT', health.data?.appKit?.runtimeEnabled === true, 'LIVE SWAP ESTIMATES'],
  ];

  return (
    <>
      <section className="hero">
        <div>
          <div className="eyebrow">
            {arcCapabilities.phase} / CHAIN {network.chain.id}
          </div>
          <h1>
            CULTURE MEETS
            <br />
            <mark>PROGRAMMABLE</mark>
            <br />MONEY.
          </h1>
          <p>
            MemeVerse is a policy-driven settlement layer for culture markets. An autonomous
            agent evaluates signals, reserves USDC, and prepares a verifiable Arc transaction—
            while execution remains explicitly human-controlled.
          </p>
          <div className="hero-actions">
            <NavLink className="btn primary" to="/agent">RUN LIVE AGENT DEMO →</NavLink>
            <NavLink className="btn secondary" to="/safety">VIEW PROOF &amp; SAFETY</NavLink>
          </div>
        </div>
        <aside>
          <Mascot />
          <p>
            PRODUCT: MEMEVERSE
            <br />INFRASTRUCTURE: <b className="acid">BUILT ON ARC</b>
            <br />MONEY + GAS: USDC
            <br />STATUS: {live ? 'BACKEND VERIFIED' : 'VERIFYING BACKEND'}
          </p>
        </aside>
      </section>
      <section className="runtime-proof" aria-label="Live infrastructure status">
        {checks.map(([label, ready, detail]) => (
          <div key={label} className={ready ? 'ready' : ''}>
            <span><i />{ready ? 'VERIFIED' : health.isPending ? 'CHECKING' : 'UNAVAILABLE'}</span>
            <strong>{label}</strong>
            <small>{detail}</small>
          </div>
        ))}
      </section>
      <section className="product-flow">
        <Title n="01—04" t="A CONTROLLED AUTONOMY LOOP" as="h2" />
        <div className="flow-grid">
          {[
            ['01', 'INGEST', 'Score engagement, retention, liquidity, risk, and confidence.'],
            ['02', 'ENFORCE', 'Apply server-side caps and reserve treasury funds atomically.'],
            ['03', 'PREPARE', 'Create a reconciliation memo and a Circle execution plan.'],
            ['04', 'VERIFY', 'Reconcile the transaction receipt and Arc contract events.'],
          ].map(([n, title, copy]) => (
            <article key={n}><span>{n}</span><h3>{title}</h3><p>{copy}</p></article>
          ))}
        </div>
      </section>
      <section className="demo-surfaces">
        <Title n="LAB" t="EXPLORE THE PRODUCT SURFACES" as="h2" />
        <div>
          <NavLink to="/agent"><small>REAL BACKEND</small><strong>AGENT SETTLEMENT</strong><span>Policy-backed USDC quote →</span></NavLink>
          <NavLink to="/trade"><small>REAL CIRCLE QUOTE</small><strong>APP KIT ESTIMATE</strong><span>USDC / EURC on Arc →</span></NavLink>
          <NavLink to="/launch"><small>SAFE SIMULATION</small><strong>MARKET LAB</strong><span>Launch without broadcast →</span></NavLink>
          <NavLink to="/safety"><small>OFFICIAL SOURCES</small><strong>PROOF &amp; SAFETY</strong><span>Contracts and lifecycle →</span></NavLink>
        </div>
      </section>
    </>
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

function SimulationReceipt({ record }) {
  if (!record) return null;

  return (
    <div className="receipt simulation-receipt" role="status">
      <b>SIMULATION READY // NO TRANSACTION BROADCAST</b>
      <span>REFERENCE: {record.reference}</span>
      <span>MEMO ID: {record.memoId.slice(0, 18)}…{record.memoId.slice(-8)}</span>
      <span>STATE: {record.state}</span>
    </div>
  );
}

function Launch() {
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [supply, setSupply] = useState('1000000000');
  const [reference, setReference] = useState(() => createReferenceId('LAUNCH'));
  const [record, setRecord] = useState(null);

  function handleSubmit(event) {
    event.preventDefault();
    setRecord(createSimulationRecord('TOKEN_LAUNCH', reference));
  }

  return (
    <section className="page">
      <Title n="03" t="MARKET LAUNCH LAB" />
      <div className="form-grid">
        <form onSubmit={handleSubmit}>
          <label>
            MEME NAME
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. UNEMPLOYED CAT"
              required
            />
          </label>
          <label>
            TICKER
            <input
              value={symbol}
              onChange={(event) => setSymbol(event.target.value.toUpperCase())}
              placeholder="UCAT"
              maxLength="6"
              required
            />
          </label>
          <label>
            TOTAL SUPPLY
            <input
              value={supply}
              onChange={(event) => setSupply(event.target.value)}
              type="number"
              min="1"
            />
          </label>
          <label>
            MEMO / RECONCILIATION REFERENCE
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              maxLength="80"
              required
            />
          </label>
          <label>
            LORE / DESCRIPTION
            <textarea placeholder="Why does this deserve liquidity?" />
          </label>
          <div className="receive">
            <span>SIMULATED ALLOCATION</span>
            <b>{Number(supply || 0).toLocaleString()} ${symbol || 'TOKEN'}</b>
          </div>
          <button className="btn primary full">PREPARE TESTNET SIMULATION →</button>
          <SimulationReceipt record={record} />
        </form>
        <aside className="spec">
          <span>DEPLOYMENT SPEC</span>
          <dl>
            <dt>MODE</dt><dd>SIMULATION</dd>
            <dt>NETWORK</dt><dd>{network.chain.name}</dd>
            <dt>SETTLEMENT</dt><dd>USDC</dd>
            <dt>MEMO</dt><dd>REFERENCE READY</dd>
            <dt>BROADCAST</dt><dd>DISABLED</dd>
          </dl>
          <Mascot />
        </aside>
      </div>
    </section>
  );
}

function Trade() {
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
      <Title n="02" t="CIRCLE APP KIT QUOTE" />
      <p className="lede">
        Request a live, authenticated Stablecoin Kits estimate for Arc Testnet. The Kit Key stays
        on the server, transaction data is discarded, and this screen never signs or broadcasts.
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

function NFTCard({ n, p, i }) {
  return (
    <article className="nft-card">
      <div className={`art art${i}`}><Mascot /></div>
      <div>
        <small>MEMEVERSE DEMO ARCHIVE</small>
        <h3>{n}</h3>
        <b>{p}</b>
        <span className="card-action">PREVIEW</span>
      </div>
    </article>
  );
}

function NFT() {
  const [modal, setModal] = useState(false);
  const closeButton = useRef(null);
  const opener = useRef(null);
  const items = [
    ...nfts,
    ['LIQUIDITY GOBLIN #2', '160 USDC'],
    ['EXIT SIGNAL #69', '110 USDC'],
    ['DEGEN RELIC #404', '320 USDC'],
  ];

  useEffect(() => {
    if (!modal) return undefined;
    closeButton.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setModal(false);
        opener.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [modal]);

  function openPreview(event) {
    opener.current = event.currentTarget;
    setModal(true);
  }

  function closePreview() {
    setModal(false);
    requestAnimationFrame(() => opener.current?.focus());
  }

  return (
    <section className="page">
      <Title n="LAB A" t="NFT ARCHIVE / DEMO" />
      <div className="nft-grid">
        {items.map((item, index) => (
          <button className="nft-trigger" type="button" key={item[0]} onClick={openPreview}>
            <NFTCard n={item[0]} p={item[1]} i={index % 3} />
          </button>
        ))}
      </div>
      {modal ? (
        <div className="modal" onClick={closePreview}>
          <div role="dialog" aria-modal="true" aria-labelledby="preview-dialog-title" onClick={(event) => event.stopPropagation()}>
            <button ref={closeButton} className="x" type="button" onClick={closePreview} aria-label="Close preview dialog">×</button>
            <div id="preview-dialog-title"><Title n="DEMO" t="PREVIEW ASK PRICE" as="h2" /></div>
            <label>
              PRICE
              <input placeholder="0.00" inputMode="decimal" />
              <small>USDC</small>
            </label>
            <button className="btn primary full" type="button">PREVIEW LISTING →</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Vault() {
  const [tab, setTab] = useState('TOKENS');

  return (
    <section className="page">
      <Title n="LAB B" t="SIMULATED ASSETS" />
      <div className="big-tabs" role="tablist" aria-label="Asset type">
        <button type="button" role="tab" aria-selected={tab === 'TOKENS'} className={tab === 'TOKENS' ? 'active' : ''} onClick={() => setTab('TOKENS')}>TOKENS / 03</button>
        <button type="button" role="tab" aria-selected={tab === 'NFTS'} className={tab === 'NFTS' ? 'active' : ''} onClick={() => setTab('NFTS')}>NFTS / 02</button>
      </div>
      {tab === 'TOKENS' ? (
        <div className="assets">
          {coins.slice(0, 3).map((coin, index) => (
            <div key={coin[0]}>
              <b>{coin[0]} <small>${coin[1]}</small></b>
              <strong>{[238400, 91420, 404808][index].toLocaleString()}</strong>
              <span>{coin[2]} DEMO</span>
              <span>DEMO ONLY</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="nft-grid">
          {nfts.slice(0, 2).map((item, index) => (
            <NFTCard key={item[0]} n={item[0]} p={item[1]} i={index} />
          ))}
        </div>
      )}
      <div className="empty">
        <Mascot small />
        <span>ONCHAIN LISTINGS: 0<br />CURRENT DATA IS SIMULATED.</span>
      </div>
    </section>
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
  const [executionReview, setExecutionReview] = useState({ open: false, confirmation: '' });
  const lastAttempt = useRef(null);
  const health = useQuery({
    queryKey: ['api-health'],
    queryFn: getApiHealth,
    retry: 1,
    staleTime: 15_000,
  });
  const circleConfigured = health.data?.circle?.configured === true;
  const approved = record?.policy?.approved === true;
  const trace = [
    ['01', 'INGEST + WEIGHT SIGNALS', record?.agentDecision ? `SCORE ${record.agentDecision.confidenceAdjustedScore}` : 'PENDING'],
    ['02', 'CHECK SERVER POLICY', record ? (approved ? 'PASS / CAP OK' : 'DENIED') : 'PENDING'],
    ['03', 'CALCULATE CREATOR SHARE', record ? `${record.amount.creatorPayoutUsdc} USDC` : 'PENDING'],
    ['04', 'PERSIST MEMO REFERENCE', record ? 'MEMO ID READY' : 'PENDING'],
    ['05', 'CIRCLE MEMO EXECUTION', record?.circle?.state ?? (record?.executionPlan ? 'AWAITING SIGNATURE' : record ? 'NOT PREPARED' : 'PENDING')],
    ['06', 'VERIFY ARC EVENTS', record?.reconciliation?.status ?? (record?.transactionHash ? 'INDEXING' : 'PENDING')],
  ];

  function updateForm(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  async function runPolicy(event) {
    event.preventDefault();
    const requestFingerprint = JSON.stringify(form);
    if (lastAttempt.current?.fingerprint !== requestFingerprint) {
      lastAttempt.current = {
        fingerprint: requestFingerprint,
        key: createIdempotencyKey(),
        observedAt: new Date().toISOString(),
      };
    }
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
        observedAt: lastAttempt.current.observedAt,
        source: 'MANUAL_DEMO',
        sourceReference: form.reference,
      },
    };
    setRequestState({ status: 'loading', error: null, replayed: false });
    setExecutionReview({ open: false, confirmation: '' });
    setRecord(null);
    try {
      const quote = await createAgentDecision(input, lastAttempt.current.key);
      setRecord(quote.data);
      if (!quote.data.policy.approved) {
        setRequestState({ status: 'denied', error: null, replayed: quote.meta.replayed });
        return;
      }
      setRequestState({ status: 'success', error: null, replayed: quote.meta.replayed });
    } catch (error) {
      setRequestState({
        status: 'error',
        error: `${error.code ?? 'REQUEST_FAILED'}: ${error.message}${error.requestId ? ` // ${error.requestId}` : ''}`,
        replayed: false,
      });
    }
  }

  async function executeWithCircle() {
    if (executionReview.confirmation !== 'EXECUTE') return;
    setRequestState({ status: 'loading', error: null, replayed: false });
    try {
      const response = await executeSettlement(record.id);
      setRecord(response.data);
      setRequestState({ status: 'submitted', error: null, replayed: false });
    } catch (error) {
      setRequestState({
        status: 'error',
        error: `${error.code ?? 'CIRCLE_EXECUTION_FAILED'}: ${error.message}${error.requestId ? ` // ${error.requestId}` : ''}`,
        replayed: false,
      });
    }
  }

  async function reconcileWithCircle() {
    setRequestState({ status: 'loading', error: null, replayed: false });
    try {
      const response = await reconcileSettlement(record.id);
      setRecord(response.data);
      setRequestState({ status: 'submitted', error: null, replayed: false });
    } catch (error) {
      setRequestState({
        status: 'error',
        error: `${error.code ?? 'CIRCLE_RECONCILIATION_FAILED'}: ${error.message}${error.requestId ? ` // ${error.requestId}` : ''}`,
        replayed: false,
      });
    }
  }

  return (
    <section className="page agent-page">
      <Title n="01" t="AUTONOMOUS SETTLEMENT" />
      <p className="lede">
        The backend weights fresh engagement, retention, liquidity, fraud-risk, and confidence
        signals against live Arc and Circle treasury evidence. The agent may quote and prepare,
        but explicit human approval is always required before Arc Memo execution.
      </p>
      <div className="agent-grid">
        <form className="agent-rules" onSubmit={runPolicy}>
          <div className="form-section-label"><span>01</span> SETTLEMENT REQUEST</div>
          <div className="agent-fields identity-fields">
            <label className="wide">RECIPIENT<input name="recipient" value={form.recipient} onChange={updateForm} spellCheck="false" required /></label>
            <label>REQUESTED SPEND<input name="requestedAmount" type="number" inputMode="decimal" min="0.01" max="25" step="0.01" value={form.requestedAmount} onChange={updateForm} required /><small>{network.money}</small></label>
            <label>REFERENCE<input name="reference" value={form.reference} onChange={updateForm} minLength="3" maxLength="120" spellCheck="false" required /></label>
          </div>
          <div className="form-section-label"><span>02</span> DECISION SIGNALS / 0—100</div>
          <div className="agent-fields signal-fields">
            <label>ENGAGEMENT<input name="engagementVelocity" type="number" min="0" max="100" value={form.engagementVelocity} onChange={updateForm} required /><small>45% WT.</small></label>
            <label>RETENTION<input name="holderRetention" type="number" min="0" max="100" value={form.holderRetention} onChange={updateForm} required /><small>25% WT.</small></label>
            <label>LIQUIDITY<input name="liquidityDepth" type="number" min="0" max="100" value={form.liquidityDepth} onChange={updateForm} required /><small>30% WT.</small></label>
            <label>FRAUD RISK<input name="fraudRisk" type="number" min="0" max="100" value={form.fraudRisk} onChange={updateForm} required /><small>MAX 20</small></label>
            <label>CONFIDENCE<input name="confidence" type="number" min="0" max="100" value={form.confidence} onChange={updateForm} required /><small>MIN 80</small></label>
          </div>
          <div className="policy-caps" aria-label="Enforced policy limits">
            <span>MAX <b>25 USDC</b></span><span>SCORE <b>78+</b></span><span>SHARE <b>60%</b></span>
            <span>DAILY <b>30 USDC</b></span><span>AUTH <b>HUMAN</b></span><span>RETRY <b>EXPLICIT</b></span>
          </div>
          <button className="btn primary full" type="submit" disabled={requestState.status === 'loading'}>
            {requestState.status === 'loading' ? 'ENFORCING POLICY…' : 'REQUEST SETTLEMENT QUOTE →'}
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
              : 'AWAITING SIGNAL // BACKEND POLICY MODE'}
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
          {record.agentDecision ? <span>AUTONOMY // QUOTE + PREPARE ONLY / HUMAN EXECUTION REQUIRED</span> : null}
          {record.reservation ? <span>RESERVATION // {Number(record.reservation.units) / 1e6} USDC / {record.reservation.status}</span> : null}
          {record.executionPlan?.targetContract ? <span>SETTLEMENT CONTRACT // {record.executionPlan.targetContract}</span> : null}
          {record.expiresAt ? <span>QUOTE EXPIRY // {record.expiresAt}</span> : null}
          {record.policy.reasons.map((reason) => <span key={reason.code}>{reason.code} // {reason.message}</span>)}
          <span>BROADCAST // {String(record.broadcast).toUpperCase()}</span>
          {record.circle ? <span>CIRCLE TX // {record.circle.transactionId} / {record.circle.state}</span> : null}
          {record.reconciliation ? <span>ARC INDEX // {record.reconciliation.status}{record.reconciliation.blockNumber ? ` / BLOCK ${record.reconciliation.blockNumber}` : ''}</span> : null}
          {record.transactionHash ? (
            <ExternalLink href={`${arcLinks.explorer}/tx/${record.transactionHash}`}>VERIFY ON ARCSCAN ↗</ExternalLink>
          ) : null}
          {approved && record.state === 'AWAITING_SIGNATURE' ? (
            executionReview.open ? (
              <div className="execution-review">
                <strong>HUMAN EXECUTION GATE</strong>
                <p>This broadcasts a testnet transaction through Circle. Verify the recipient, amount, memo, chain {arc.id}, and contract before proceeding.</p>
                <label>TYPE EXECUTE TO AUTHORIZE
                  <input
                    value={executionReview.confirmation}
                    onChange={(event) => setExecutionReview((current) => ({ ...current, confirmation: event.target.value }))}
                    autoComplete="off"
                    spellCheck="false"
                  />
                </label>
                <div>
                  <button className="btn" type="button" onClick={() => setExecutionReview({ open: false, confirmation: '' })}>CANCEL</button>
                  <button className="btn circle-action" type="button" disabled={executionReview.confirmation !== 'EXECUTE' || requestState.status === 'loading'} onClick={executeWithCircle}>EXECUTE VIA CIRCLE →</button>
                </div>
              </div>
            ) : (
              <button
                className="btn circle-action"
                type="button"
                disabled={!circleConfigured || requestState.status === 'loading'}
                onClick={() => setExecutionReview({ open: true, confirmation: '' })}
              >
                {circleConfigured ? 'REVIEW HUMAN EXECUTION →' : 'CIRCLE + SETTLEMENT CONTRACT REQUIRED'}
              </button>
            )
          ) : null}
          {record.circle && !['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'].includes(record.state) ? (
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
        <span>VERIFIED SETTLEMENT CONTRACT</span>
        <span>POSTGRES TREASURY RESERVATIONS</span>
        <span>EXPLICIT TX STATES</span>
        <span>NO BLIND RETRIES</span>
        <span>CONDITIONAL SETTLEMENT</span>
        <span>CIRCLE DEV-CONTROLLED EOA</span>
        <span>APP KIT QUOTES LIVE / FAIL-CLOSED</span>
        <span>SEPARATE LEASED WORKER</span>
      </div>
    </section>
  );
}

function ResourceCard({ label, value, href, note }) {
  return (
    <article className="resource-card">
      <small>{label}</small>
      <strong>{value}</strong>
      <p>{note}</p>
      <ExternalLink href={href}>OPEN OFFICIAL SOURCE ↗</ExternalLink>
    </article>
  );
}

function Safety() {
  return (
    <section className="page safety-page">
      <Title n="04" t="PROOF / SAFETY / SOURCES" />
      <div className="risk-banner">
        <strong>TESTNET ONLY</strong>
        <span>No MemeVerse screen should ask for a seed phrase or private key. Treat unsolicited support DMs as scams.</span>
      </div>
      <div className="resource-grid">
        <ResourceCard label="NETWORK" value={`CHAIN ${arc.id}`} href={arcLinks.docs} note="Verify network parameters and current Arc documentation before signing." />
        <ResourceCard label="HEALTH" value="ARC STATUS" href={arcLinks.status} note="Check incidents and degraded service before retrying failed transactions." />
        <ResourceCard label="TEST FUNDS" value="CIRCLE FAUCET" href={arcLinks.faucet} note="Use only the official faucet. Testnet assets have no real-world value." />
        <ResourceCard label="VERIFY" value="ARCSCAN" href={arcLinks.explorer} note="A hash is not final proof; confirm the receipt status and expected events." />
        <ResourceCard label="RECONCILIATION" value="TX MEMOS" href={arcLinks.memos} note="Memo IDs connect onchain calls to application records. Direct EOA callers only." />
        <ResourceCard label="MULTI-CALL" value="BATCHED TX" href={arcLinks.batches} note="Define allow-failure policy explicitly and verify every target event." />
        <ResourceCard label="BRAND" value="BUILT ON ARC" href={arcLinks.brand} note="MemeVerse leads as the product brand; Arc is presented only as its infrastructure." />
      </div>
      <div className="safety-grid">
        <section>
          <h3>TRANSACTION LIFECYCLE</h3>
          <div className="state-pipeline">
            {transactionPhases.map((phase, index) => (
              <span key={phase}><b>0{index + 1}</b>{phase}</span>
            ))}
          </div>
          <p>Persist the reference, latest hash and failure class. Never rebroadcast blindly after an unknown or post-broadcast failure.</p>
        </section>
        <section>
          <h3>VERIFIED TESTNET CONTRACTS</h3>
          <dl>
            <dt>USDC</dt><dd>{arcContracts.usdc.slice(0, 10)}…{arcContracts.usdc.slice(-6)}</dd>
            <dt>MEMO</dt><dd>{arcContracts.memo.slice(0, 10)}…{arcContracts.memo.slice(-6)}</dd>
            <dt>MEMEVERSE</dt><dd><ExternalLink href={`${arcLinks.explorer}/address/${arcContracts.memeVerseSettlement}`}>{arcContracts.memeVerseSettlement.slice(0, 10)}…{arcContracts.memeVerseSettlement.slice(-6)}</ExternalLink></dd>
            <dt>BATCH</dt><dd>{arcContracts.multicall3From.slice(0, 10)}…{arcContracts.multicall3From.slice(-6)}</dd>
          </dl>
          <ExternalLink href={arcLinks.contracts}>VERIFY ALL ADDRESSES ↗</ExternalLink>
        </section>
      </div>
      <div className="roadmap-note">
        <b>POST-QUANTUM STATUS:</b> Arc documents this as a roadmap and not a currently available Testnet feature. MemeVerse makes no quantum-security claim today.
        <ExternalLink href={arcLinks.security}> READ OFFICIAL ROADMAP ↗</ExternalLink>
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

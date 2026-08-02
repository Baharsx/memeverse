import React, { useEffect, useRef, useState } from 'react';
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
import {
  createIdempotencyKey,
  createAgentDecision,
  estimateAppKitSwap,
  executeSettlement,
  getAppKitCapabilities,
  getApiHealth,
  reconcileSettlement,
} from './api';
import {
  factoryAbi,
  formatTokenAmount,
  formatUsdc,
  loadFactoryConfig,
  loadMarkets,
  loadUsdcBalance,
  marketAbi,
  minimumAfterSlippage,
  parseUsdc,
  parseWholeTokens,
  quoteBuy,
  quoteSell,
  usdcAbi,
} from './market';
import { useOnchainAction } from './use-onchain-action';
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
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
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
const demoCoins = [
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

function ExternalLink({ href, children, className = '', ...props }) {
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer" {...props}>
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
            {market ? <>{market.symbol} <b>{formatUsdc(market.spotPriceUsdc)} USDC</b>{' '}<em className="up">ONCHAIN</em></> : <b>NO ONCHAIN MARKETS YET // LAUNCH THE FIRST</b>}
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

function Shell() {
  const navItems = [
    ['01', 'MARKETS', '/markets'],
    ['02', 'LAUNCH', '/launch'],
    ['03', 'AGENT', '/agent'],
    ['04', 'QUOTE', '/quote'],
    ['05', 'PROOF', '/safety'],
  ];

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
          <Route path="/markets" element={<Markets />} />
          <Route path="/trade" element={<Markets />} />
          <Route path="/launch" element={<Launch />} />
          <Route path="/quote" element={<Quote />} />
          <Route path="/nft" element={<NFT />} />
          <Route path="/vault" element={<Vault />} />
          <Route path="/agent" element={<Agent />} />
          <Route path="/safety" element={<Safety />} />
        </Routes>
      </main>
      <footer>
        <span>MEMEVERSE © 2026</span>
        <span>{network.chain.name.toUpperCase()} // CHAIN {network.chain.id}</span>
        <ExternalLink className="social-link" href="https://x.com/memeversebiz" aria-label="MemeVerse on X">X / @MEMEVERSEBIZ ↗</ExternalLink>
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
  const factory = useQuery({
    queryKey: ['market-factory-config'],
    queryFn: loadFactoryConfig,
    retry: 1,
    refetchInterval: 30_000,
  });
  const live = health.data?.status === 'ok';
  const checks = [
    ['ARC RPC', health.data?.arc?.status === 'verified', health.data?.arc?.blockNumber ? `BLOCK ${health.data.arc.blockNumber}` : 'VERIFYING'],
    ['MARKET FACTORY', Boolean(factory.data), factory.data ? `${factory.data.marketCount} MARKETS` : 'VERIFYING'],
    ['POSTGRES', health.data?.persistence?.ready === true, 'RESERVATIONS READY'],
    ['CIRCLE WALLET', health.data?.circle?.configured === true, 'DEV-CONTROLLED'],
    ['CIRCLE QUOTE', health.data?.appKit?.runtimeEnabled === true, 'LIVE SWAP ESTIMATES'],
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
            Launch and trade meme assets against real faucet-funded USDC on Arc Public Testnet.
            Every balance, quote, market, fee allocation, and receipt comes from the chain.
          </p>
          <div className="hero-actions">
            <NavLink className="btn primary" to="/markets">OPEN ONCHAIN MARKETS →</NavLink>
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
          <NavLink to="/markets"><small>REAL ARC CONTRACTS</small><strong>USDC MARKETS</strong><span>Buy and sell onchain →</span></NavLink>
          <NavLink to="/launch"><small>WALLET SIGNED</small><strong>LAUNCH A MEME</strong><span>Deploy a real market →</span></NavLink>
          <NavLink to="/agent"><small>REAL BACKEND</small><strong>AGENT SETTLEMENT</strong><span>Policy-backed USDC quote →</span></NavLink>
          <NavLink to="/quote"><small>REAL CIRCLE QUOTE</small><strong>STABLECOIN ESTIMATE</strong><span>USDC / EURC on Arc →</span></NavLink>
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

function Launch() {
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [supply, setSupply] = useState('1000000');
  const [description, setDescription] = useState('');
  const [basePrice, setBasePrice] = useState('0.0001');
  const [slopePrice, setSlopePrice] = useState('0.001');
  const [review, setReview] = useState(false);
  const [result, setResult] = useState(null);
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const action = useOnchainAction();
  const factory = useQuery({
    queryKey: ['market-factory-config'],
    queryFn: loadFactoryConfig,
    retry: 1,
  });
  const onArc = isConnected && chainId === arc.id;

  function handleSubmit(event) {
    event.preventDefault();
    setReview(true);
    setResult(null);
    action.reset();
  }

  async function launchMarket() {
    try {
      const receipt = await action.execute({
        address: arcContracts.memeVerseFactory,
        abi: factoryAbi,
        functionName: 'createMarket',
        args: [name.trim(), symbol.trim().toUpperCase(), description.trim(), BigInt(supply), parseUsdc(basePrice), parseUsdc(slopePrice)],
        chainId: arc.id,
      });
      const [event] = parseEventLogs({ abi: factoryAbi, logs: receipt.logs, eventName: 'MarketCreated', strict: true });
      setResult({ market: event.args.market, token: event.args.token, creator: address, hash: receipt.transactionHash });
      queryClient.invalidateQueries({ queryKey: ['onchain-markets'] });
      queryClient.invalidateQueries({ queryKey: ['market-factory-config'] });
    } catch { /* The action state presents validation, wallet, and receipt errors. */ }
  }

  return (
    <section className="page">
      <Title n="02" t="LAUNCH ON ARC" />
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
      <Title n="01" t="ONCHAIN USDC MARKETS" />
      <p className="lede">Markets are read directly from the deployed MemeVerse factory. Quotes, reserves, positions, fees, and balances are live Arc Public Testnet state.</p>
      {markets.isError ? <p className="agent-error" role="alert">ARC RPC READ FAILED // {markets.error.shortMessage ?? 'Public RPC unavailable. Retry shortly.'}</p> : null}
      {!markets.isPending && !markets.data?.length ? (
        <div className="empty"><Mascot small /><span>ONCHAIN MARKETS: 0<br /><NavLink to="/launch">LAUNCH THE FIRST MARKET →</NavLink></span></div>
      ) : null}
      {markets.data?.length ? (
        <div className="market-layout">
          <div className="market-list" aria-label="Onchain markets">
            {markets.data.map((market) => (
              <button key={market.address} type="button" className={selected?.address === market.address ? 'active' : ''} onClick={() => setSelectedAddress(market.address)}>
                <span>{market.symbol}</span><strong>{market.name}</strong><small>{formatUsdc(market.spotPriceUsdc)} USDC / TOKEN</small><em>{market.soldTokenCount.toLocaleString()} / {market.totalSupplyTokens.toLocaleString()} SOLD</em>
              </button>
            ))}
          </div>
          {selected ? <div className="market-terminal">
            <section className="market-proof">
              <div><small>MARKET</small><strong>{selected.name} / ${selected.symbol}</strong><ExternalLink href={`${arcLinks.explorer}/address/${selected.address}`}>{shortAddress(selected.address)} ↗</ExternalLink></div>
              <dl>
                <dt>SPOT QUOTE</dt><dd>{formatUsdc(selected.spotPriceUsdc)} USDC</dd>
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
              {side === 'BUY' ? <form onSubmit={buyTokens}>
                <label>USDC AMOUNT<input value={buyAmount} onChange={(event) => setBuyAmount(event.target.value)} type="number" inputMode="decimal" min="0.000001" step="0.000001" required /><small>USDC</small></label>
                <div className="trade-review">
                  <span>WALLET BALANCE <b>{onArc && usdcBalance.data !== undefined ? `${formatUsdc(usdcBalance.data)} USDC` : 'CONNECT ON ARC'}</b></span>
                  <span>ESTIMATED OUT <b>{buyQuote.data ? `${formatTokenAmount(buyQuote.data[0], 0)} ${selected.symbol}` : '—'}</b></span>
                  <span>CURVE COST <b>{buyQuote.data ? `${formatUsdc(buyQuote.data[1])} USDC` : '—'}</b></span>
                  <span>CREATOR ALLOCATION <b>{buyQuote.data ? `${formatUsdc(buyQuote.data[2])} USDC` : '—'}</b></span>
                  <span>TREASURY ALLOCATION <b>{buyQuote.data ? `${formatUsdc(buyQuote.data[3])} USDC` : '—'}</b></span>
                  <span>MINIMUM OUT / SLIPPAGE <b>{buyQuote.data ? `${formatTokenAmount(minimumAfterSlippage(buyQuote.data[0], slippageBps), 2)} / 1%` : '—'}</b></span>
                </div>
                {buyInputError ? <p className="agent-error">{buyInputError}</p> : null}
                {allowanceRequired ? <button className="btn secondary full" type="button" disabled={!onArc || approval.state.status === 'WALLET_SIGNATURE' || approval.state.status === 'SUBMITTED'} onClick={approveUsdc}>APPROVE {buyAmount || '0'} USDC →</button> : null}
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
      <Title n="02" t="CIRCLE STABLECOIN QUOTE" />
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

function NFTCard({ n, p, i, onPreview }) {
  return (
    <article className="nft-card">
      <div className={`art art${i}`}><Mascot /></div>
      <div>
        <small>MEMEVERSE DEMO ARCHIVE</small>
        <h3>{n}</h3>
        <b>{p}</b>
        {onPreview ? <button className="card-action" type="button" onClick={onPreview}>PREVIEW</button> : null}
      </div>
    </article>
  );
}

function NFT() {
  const [modal, setModal] = useState(false);
  const [listingPreview, setListingPreview] = useState(false);
  const [price, setPrice] = useState('');
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
    setListingPreview(false);
    setPrice('');
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
          <NFTCard key={item[0]} n={item[0]} p={item[1]} i={index % 3} onPreview={openPreview} />
        ))}
      </div>
      {modal ? (
        <div className="modal" onClick={closePreview}>
          <div role="dialog" aria-modal="true" aria-labelledby="preview-dialog-title" onClick={(event) => event.stopPropagation()}>
            <button ref={closeButton} className="x" type="button" onClick={closePreview} aria-label="Close preview dialog">×</button>
            <div id="preview-dialog-title"><Title n="DEMO" t="PREVIEW ASK PRICE" as="h2" /></div>
            <label>
              PRICE
              <input value={price} onChange={(event) => setPrice(event.target.value)} placeholder="0.00" inputMode="decimal" />
              <small>USDC</small>
            </label>
            <button className="btn primary full" type="button" onClick={() => setListingPreview(true)}>PREVIEW LISTING →</button>
            {listingPreview ? <div className="receipt simulation-receipt" role="status"><b>SIMULATION READY // NO BROADCAST</b><span>{price ? `ASK PREVIEW: ${price} USDC` : 'ASK PREVIEW: NOT SET'}</span><span>NFT listings are not live in this Testnet MVP.</span></div> : null}
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
          {demoCoins.slice(0, 3).map((coin, index) => (
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
      <Title n="01" t="AGENT-GUIDED SETTLEMENT" />
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
        <span>CIRCLE KIT QUOTES LIVE / FAIL-CLOSED</span>
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
        <ResourceCard label="MARKETS" value="FACTORY" href={`${arcLinks.explorer}/address/${arcContracts.memeVerseFactory}`} note="Immutable registry for real MemeVerse token launches and USDC markets." />
        <ResourceCard label="RECONCILIATION" value="TX MEMOS" href={arcLinks.memos} note="Memo IDs connect Agent settlement calls to application records. Direct EOA callers only." />
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
            <dt>MARKET FACTORY</dt><dd><ExternalLink href={`${arcLinks.explorer}/address/${arcContracts.memeVerseFactory}`}>{arcContracts.memeVerseFactory.slice(0, 10)}…{arcContracts.memeVerseFactory.slice(-6)}</ExternalLink></dd>
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

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { parseEventLogs } from 'viem';
import {
  WagmiProvider,
  useAccount,
  useConnect,
  useDisconnect,
} from 'wagmi';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  ARC_IS_MAINNET,
  arc,
  arcContracts,
  arcLinks,
} from './arc';
import { assertBrowserReadChain } from './boot-chain.js';
import { openWalletModal, wagmiConfig, walletModalAvailable } from './reown-appkit.js';
import {
  ARC_MANUAL_NETWORK,
  ARC_NETWORK_ACTION,
  ARC_SWITCH_STATUS,
  arcNetworkAction,
} from './arc-network-onboarding.js';
import { useArcNetwork, useArcNetworkSwitch } from './use-arc-network.js';
import {
  RESTRICTED_BROWSER_HINT,
  isRestrictedEmbeddedBrowser,
  walletButtonLabel,
} from './wallet-connection.js';
import { getApiHealth } from './api';
import { Referral, Campaigns } from './rewards-views.jsx';
import {
  marketAvailability,
  marketDescriptionForDisplay,
  marketMinimumBuyUsdc,
  marketBuyPriceLabel,
  marketSpotLabel,
  marketSpotPerTokenLabel,
  publicMarkets,
} from './market-display';
import {
  filterTradeableMarkets,
  marketSoldPercent,
  sortTradeableMarkets,
} from './imported-markets';
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
  parseTokenAmount,
  quoteBuy,
  quoteSell,
  tokenSupplyValue,
  usdcAbi,
} from './market';
import { useOnchainAction } from './use-onchain-action';
import { useDebouncedValue } from './use-debounced-value.js';
import {
  MarketImage,
  mediaContentUrl,
  useImageSelection,
  useMediaUpload,
} from './media-views.jsx';
import { getActivity, getMarketImages } from './api';
import { TREND_PERIODS, defaultTrendPeriod, formatDollars, shortTrader, timeAgo, trendingMarkets } from './activity';
import { SELL_PRESETS, sellPresetAmount, tradeButtonState, tradeStatusLine } from './trade-flow';
import { QUICK_BUY_AMOUNTS, fundingLink, needsMoreUsdc } from './funding';
import { MEDIA_ACTIONS } from './media-authorization';
import { canRetryLaunchArtwork, launchArtworkStage } from './media-upload';
import { BrowserRouter, NavLink, Route, RouterContext, Routes } from './router.jsx';
import './styles.css';

const queryClient = new QueryClient();
// The ticker, home and anonymous board observe the same cache and in-flight RPC request.
function marketQueryOptions(address) {
  return {
    queryKey: ['onchain-markets', address ?? 'anonymous'],
    queryFn: () => loadMarkets(address),
    retry: 1,
    staleTime: 12_000,
    refetchInterval: 15_000,
    // Keep public cards visible while a newly connected wallet loads its own positions.
    // Anonymous records contain no previous wallet's balances or allowances.
    placeholderData: address ? () => queryClient.getQueryData(['onchain-markets', 'anonymous']) : undefined,
  };
}
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

function prepareTickerImage(src) {
  return new Promise((resolve) => {
    const picture = new Image();
    const finish = (ready) => {
      clearTimeout(timeout);
      picture.onload = null;
      picture.onerror = null;
      resolve(ready ? src : null);
    };
    const timeout = setTimeout(() => finish(false), 3000);
    picture.onload = () => picture.decode().then(() => finish(true), () => finish(false));
    picture.onerror = () => finish(false);
    picture.src = src;
  });
}

function MarketTicker({ items, artwork, viewportRef }) {
  const sequenceRef = useRef(null);
  const [layout, setLayout] = useState({ copies: 1, seconds: 60, ready: false });
  const marketKey = items.map((market) => market.address).join(',');
  useLayoutEffect(() => {
    function measure() {
      const width = sequenceRef.current?.getBoundingClientRect().width;
      if (!width || !viewportRef.current) return;
      const copies = Math.max(1, Math.ceil(viewportRef.current.clientWidth / width));
      const seconds = Math.max(20, width * copies / 24);
      setLayout((previous) => previous.copies === copies && previous.seconds === seconds && previous.ready
        ? previous : { copies, seconds, ready: true });
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sequenceRef.current);
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [marketKey, viewportRef]);

  return (
    <div className="marquee-track" data-ready={layout.ready} style={{ '--ticker-duration': `${layout.seconds}s` }}>
      {[0, 1].map((cycle) => (
        <div className="ticker-cycle" key={cycle} aria-hidden={cycle === 1 ? true : undefined}>
          {Array.from({ length: layout.copies }, (_, copy) => (
            <div className="ticker-sequence" key={copy} ref={cycle === 0 && copy === 0 ? sequenceRef : undefined} aria-hidden={copy > 0 ? true : undefined}>
              {items.map((market, index) => (
                <span
                  className={`ticker-item${cycle === 0 ? ' ticker-enter' : ''}`}
                  key={market.address}
                  style={{ '--ticker-delay': `${Math.max(0, Math.min(items.length * layout.copies, 8) - 1 - Math.min(copy * items.length + index, 7)) * 90}ms` }}
                >
                  {artwork[market.address] ? <img className="ticker-avatar" src={artwork[market.address]} width="24" height="24" alt="" decoding="async" referrerPolicy="no-referrer" /> : <span className="ticker-avatar" aria-hidden="true" />}
                  <span className="ticker-symbol">{market.symbol}</span>
                  <b className="ticker-price">{marketSpotLabel(market, formatUsdc)}</b>
                  <em className="up">ONCHAIN</em>
                </span>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Marquee() {
  const markets = useQuery(marketQueryOptions());
  // Same presentation filter as the Markets selector, so the ticker and the list can never
  // disagree about what a visitor is being shown.
  const items = publicMarkets(markets.data);
  const imageKey = items.map((market) => market.address).join(',');
  const images = useQuery({
    queryKey: ['market-images', imageKey],
    queryFn: () => getMarketImages(imageKey.split(',')),
    enabled: items.length > 0,
    staleTime: 30_000,
  });
  const [artwork, setArtwork] = useState(null);
  const viewportRef = useRef(null);
  useEffect(() => {
    if (!imageKey || !images.data) return undefined;
    let current = true;
    const fallback = `${import.meta.env.BASE_URL}memeverse-ticker-mark-v1.webp`;
    Promise.all(imageKey.split(',').map(async (address) => {
      const requested = mediaContentUrl(images.data[address]?.url);
      const ready = requested ? await prepareTickerImage(requested) : null;
      return [address, ready ?? await prepareTickerImage(fallback)];
    })).then((entries) => { if (current) setArtwork(Object.fromEntries(entries)); });
    return () => { current = false; };
  }, [imageKey, images.data]);
  return (
    <div className="marquee" ref={viewportRef} role="group" aria-label="Live market ticker">
      {items.length > 0 && artwork ? <MarketTicker items={items} artwork={artwork} viewportRef={viewportRef} /> : null}
    </div>
  );
}

/**
 * Opens the Reown AppKit modal, and remembers that it was asked to.
 *
 * The second part only matters inside an embedded in-app browser. Discord, Telegram, and most
 * other Android WebViews block navigation to a wallet's URL scheme at the OS level, so the modal
 * opens and then nothing happens — a dead end this page cannot fix from JavaScript. The hint is
 * therefore shown only after a real attempt in a browser known to block them, never pre-emptively
 * and never to an ordinary Safari or Chrome visitor.
 */
function useWalletModal() {
  const [attempted, setAttempted] = useState(false);
  const restricted = useMemo(
    () => isRestrictedEmbeddedBrowser(typeof navigator === 'undefined' ? '' : navigator.userAgent),
    [],
  );

  function open(view = 'Connect') {
    setAttempted(true);
    return openWalletModal(view);
  }

  return { open, attempted, showRestrictedBrowserHint: restricted && attempted };
}

/**
 * The only path left for a build that shipped without VITE_REOWN_PROJECT_ID. There is no relay to
 * pair over in that case, so a browser extension is all that can still be offered; the header says
 * as much rather than pretending the modal exists. A correctly configured deployment never reaches
 * this code.
 */
function useInjectedFallback() {
  const { connect, connectors, isPending } = useConnect();
  return {
    isPending,
    connect() {
      const injectedConnector = connectors.find((connector) => connector.type === 'injected');
      if (injectedConnector) connect({ connector: injectedConnector });
    },
  };
}

function Wallet() {
  const { address, isConnected, isConnecting, isReconnecting } = useAccount();
  const { onArc } = useArcNetwork();
  const modal = useWalletModal();
  const connectInjected = useInjectedFallback();
  const balance = useQuery({
    queryKey: ['wallet-usdc', address],
    queryFn: () => loadUsdcBalance(address),
    enabled: onArc,
    staleTime: 12_000,
    refetchInterval: 12_000,
  });
  const balanceLabel = onArc && balance.data !== undefined
    ? `${formatUsdc(balance.data, 4)} USDC`
    : onArc ? 'BALANCE UNAVAILABLE' : `SWITCH TO ${network.chain.name.toUpperCase()}`;

  /*
    One button, two destinations, and never a disconnect. Tapping while connected opens the
    Account view — which is where disconnect lives — because a header button that drops the
    session on an accidental tap is a trap on a touch screen.

    Disconnected, the label is unconditional. It used to read WALLET UNAVAILABLE whenever no
    injected provider answered, which is the normal state of every ordinary mobile browser: the
    button announced failure to precisely the visitors WalletConnect exists to serve.
  */
  if (isConnected) {
    return (
      <button
        className="wallet connected"
        type="button"
        onClick={() => modal.open('Account')}
        aria-label={`Wallet ${address} — open account controls`}
      >
        <i />
        <span className="wallet-balance">{balanceLabel} // </span>
        <span className="wallet-address">{walletButtonLabel({ isConnected, address })}</span>
      </button>
    );
  }

  return (
    <>
      <button
        className="wallet"
        type="button"
        onClick={() => { if (!modal.open('Connect')) connectInjected.connect(); }}
        aria-label="Connect a wallet"
      >
        <span className="wallet-address">
          {walletButtonLabel({ isConnecting: isConnecting || isReconnecting || connectInjected.isPending })}
        </span>
      </button>
      {modal.showRestrictedBrowserHint ? <p className="wallet-hint" role="status">{RESTRICTED_BROWSER_HINT}</p> : null}
      {modal.attempted && !walletModalAvailable
        ? <p className="wallet-hint" role="status">WALLETCONNECT UNCONFIGURED // BROWSER EXTENSION ONLY</p>
        : null}
    </>
  );
}

/**
 * The switch-to-Arc control.
 *
 * It no longer fires `switchChain` and forgets it. A wallet that has never seen Arc has to be
 * asked to add it, over a request WalletConnect will actually deliver, and the result has to be
 * read back from the wallet rather than assumed — all of which lives in `useArcNetworkSwitch`.
 * What is left here is the button, one line of plain error text, and the manual settings a
 * visitor needs if their wallet refuses custom networks altogether.
 */
function NetworkStatus() {
  const { chainId, isConnected, onArc, sessionAuthorized } = useArcNetwork();
  const arcSwitch = useArcNetworkSwitch();
  const { disconnectAsync } = useDisconnect();
  const [showManual, setShowManual] = useState(false);
  const action = arcNetworkAction({
    isConnected,
    chainId,
    sessionAuthorized,
    switchStatus: arcSwitch.status,
  });
  const actionLabel = {
    [ARC_NETWORK_ACTION.ADD]: ARC_IS_MAINNET ? 'ADD ARC MAINNET' : 'ADD ARC TESTNET',
    [ARC_NETWORK_ACTION.SWITCH]: 'SWITCH TO ARC',
    [ARC_NETWORK_ACTION.RECONNECT]: 'RECONNECT WALLET',
  }[action] ?? null;

  async function requestArc() {
    setShowManual(false);
    const result = await arcSwitch.switchToArc();
    // A reconnect is a normal next step, not a dead end, so the manual settings stay hidden for it.
    if (!result.ok && result.status !== ARC_SWITCH_STATUS.SESSION_REAUTH_REQUIRED) setShowManual(true);
  }

  /*
    The wallet now has Arc but this session does not, and only the wallet can add a chain to a
    live session. A fresh session is the supported way through: AppKit asks for Arc again on
    connect, and this time the wallet recognises it. Nothing about the session is hand-edited.
  */
  async function reconnectForArc() {
    try {
      await disconnectAsync();
    } finally {
      openWalletModal('Connect');
    }
  }

  function runAction() {
    if (action === ARC_NETWORK_ACTION.RECONNECT) return reconnectForArc();
    if (action === ARC_NETWORK_ACTION.ADD || action === ARC_NETWORK_ACTION.SWITCH) return requestArc();
    return undefined;
  }

  if (onArc || (!actionLabel && !(arcSwitch.failed && arcSwitch.message))) return null;

  return (
    <div className="network-switch" role="group" aria-label={`${arc.name} connection status`}>
      {actionLabel ? (
        <button
          type="button"
          className="network-action"
          disabled={arcSwitch.isPending}
          onClick={runAction}
        >
          {arcSwitch.isPending ? 'SETTING UP ARC…' : actionLabel}
        </button>
      ) : null}
      {!onArc && arcSwitch.failed && arcSwitch.message
        ? (
          <div className="network-error">
            <span role="alert">{arcSwitch.message}</span>
            {action !== ARC_NETWORK_ACTION.RECONNECT ? (
              <button type="button" className="network-manual" onClick={() => setShowManual((shown) => !shown)}>
                ADD ARC MANUALLY
              </button>
            ) : null}
            {showManual ? (
              <dl className="network-manual-settings" aria-label={`${arc.name} manual network settings`}>
                <div><dt>NETWORK</dt><dd>{ARC_MANUAL_NETWORK.chainName}</dd></div>
                <div><dt>CHAIN ID</dt><dd>{ARC_MANUAL_NETWORK.chainIdDecimal}</dd></div>
                <div><dt>HEX</dt><dd>{ARC_MANUAL_NETWORK.chainIdHex}</dd></div>
                <div><dt>RPC</dt><dd>{ARC_MANUAL_NETWORK.rpcUrl}</dd></div>
                <div><dt>CURRENCY</dt><dd>{ARC_MANUAL_NETWORK.currencySymbol}</dd></div>
                <div><dt>EXPLORER</dt><dd>{ARC_MANUAL_NETWORK.explorer}</dd></div>
              </dl>
            ) : null}
          </div>
        )
        : null}
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
  ['03', 'REFERRAL', '/referral'],
  ['04', 'CAMPAIGNS', '/campaigns'],
];

function Shell() {
  const { pathname } = React.useContext(RouterContext);
  const mainRef = useRef(null);
  const previousPath = useRef(pathname);
  useEffect(() => {
    document.title = `${pathname === '/' ? 'A meme becomes a market' : navItems.find((item) => item[2] === pathname)?.[1] ?? (pathname === '/trade' ? 'MARKETS' : 'Page not found')} | MemeVerse`;
    if (previousPath.current !== pathname) {
      mainRef.current?.focus({ preventScroll: true });
      previousPath.current = pathname;
    }
  }, [pathname]);

  return (
    <>
      <a className="skip-link" href="#main-content">SKIP TO PRODUCT</a>
      <Marquee />
      <header className="site-header">
        <NavLink className="brand" to="/">
          <img
            className="brand-lockup"
            src={`${import.meta.env.BASE_URL}memeverse-lockup-transparent-v2.webp`}
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
      <main id="main-content" ref={mainRef} tabIndex={-1}>
        <div key={pathname} className="surface-enter">
          <Routes notFound={<NotFound />}>
            <Route path="/" element={<Home />} />
            <Route path="/markets" element={<Markets />} />
            <Route path="/trade" element={<Markets />} />
            <Route path="/launch" element={<Launch />} />
            <Route path="/referral" element={<Referral connectWallet={<Wallet />} />} />
            <Route path="/campaigns" element={<Campaigns />} />
          </Routes>
        </div>
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
 * The economy, in the order a visitor walks it. Each step is a real surface.
 */
const FUNDING = fundingLink(ARC_IS_MAINNET);
const economySteps = [
  ['01', 'GET USDC', FUNDING.href, ARC_IS_MAINNET
    ? 'Bridge USDC to Arc from Base or another chain with Relay. Gas on Arc is paid in USDC too.'
    : 'Claim free test USDC on Arc Testnet from the Circle faucet.'],
  ['02', 'LAUNCH FOR $0', '/launch', 'Name, ticker, image. No launch fee, only a few cents of gas. Earn 1% of every trade.'],
  ['03', 'TRADE FROM $1', '/markets', 'Buy fractions of new tokens from $1 and sell any amount back to the curve.'],
];

function AssetCarousel({ label, detail, trackRef, count, children }) {
  const [autoPaused, setAutoPaused] = useState(false);
  const moveRef = useRef(null);
  const cards = React.Children.toArray(children);
  useEffect(() => {
    const node = trackRef.current;
    if (!node || count < 2) return undefined;
    const container = node.closest('.carousel');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, timer = 0, hovering = false, visible = false;
    function geometry() {
      const first = node.querySelector('.carousel-card');
      const next = first?.nextElementSibling;
      return first && next ? { step: next.offsetLeft - first.offsetLeft, cycle: node.querySelector('.carousel-copy').offsetLeft - first.offsetLeft } : null;
    }
    function schedule() {
      clearTimeout(timer);
      if (!autoPaused && !reduced.matches && !hovering && visible && !document.hidden
        && !container.contains(document.activeElement)) timer = setTimeout(() => move(1), 10000);
    }
    function normalize() {
      const size = geometry();
      if (!size || frame) return;
      if (node.scrollLeft >= size.cycle) node.scrollTo({ left: node.scrollLeft % size.cycle, behavior: 'instant' });
    }
    function stop() {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      frame = 0;
    }
    function move(direction) {
      stop();
      const size = geometry();
      if (!size) return;
      normalize();
      if (direction < 0 && node.scrollLeft < 1) node.scrollTo({ left: size.cycle, behavior: 'instant' });
      const start = node.scrollLeft;
      const target = Math.max(0, (Math.round(start / size.step) + direction) * size.step);
      if (reduced.matches) {
        node.scrollTo({ left: target, behavior: 'instant' });
        normalize();
        return;
      }
      const started = performance.now();
      function animate(now) {
        const progress = Math.min(1, (now - started) / 650);
        const eased = progress < .5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
        node.scrollTo({ left: start + (target - start) * eased, behavior: 'instant' });
        if (progress < 1) frame = requestAnimationFrame(animate);
        else { frame = 0; normalize(); schedule(); }
      }
      frame = requestAnimationFrame(animate);
    }
    const enter = () => { hovering = true; clearTimeout(timer); };
    const leave = () => { hovering = false; schedule(); };
    const interact = () => { stop(); schedule(); };
    const focus = () => clearTimeout(timer);
    const blur = () => schedule();
    const visibility = () => { if (document.hidden) stop(); else schedule(); };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) schedule(); else stop();
    });
    observer.observe(node);
    moveRef.current = move;
    container.addEventListener('pointerenter', enter);
    container.addEventListener('pointerleave', leave);
    container.addEventListener('pointerdown', interact, { passive: true });
    container.addEventListener('wheel', interact, { passive: true });
    container.addEventListener('focusin', focus);
    container.addEventListener('focusout', blur);
    node.addEventListener('scrollend', normalize);
    document.addEventListener('visibilitychange', visibility);
    reduced.addEventListener('change', interact);
    return () => {
      stop(); observer.disconnect(); moveRef.current = null;
      container.removeEventListener('pointerenter', enter); container.removeEventListener('pointerleave', leave);
      container.removeEventListener('pointerdown', interact); container.removeEventListener('wheel', interact);
      container.removeEventListener('focusin', focus); container.removeEventListener('focusout', blur);
      node.removeEventListener('scrollend', normalize);
      document.removeEventListener('visibilitychange', visibility);
      reduced.removeEventListener('change', interact);
    };
  }, [count, autoPaused, trackRef]);

  return (
    <div className="carousel" aria-roledescription="carousel" aria-label={label}>
      <div className="carousel-head">
        <div><h2>{label}</h2><p>{detail}</p></div>
        {count > 1 ? (
          <div className="carousel-controls">
            <button type="button" onClick={() => moveRef.current?.(-1)} aria-label={`Previous ${label}`}>←</button>
            <button type="button" aria-pressed={autoPaused} onClick={() => setAutoPaused((paused) => !paused)} aria-label={autoPaused ? 'Resume automatic scrolling' : 'Pause automatic scrolling'}>{autoPaused ? '▶' : 'Ⅱ'}</button>
            <button type="button" onClick={() => moveRef.current?.(1)} aria-label={`Next ${label}`}>→</button>
          </div>
        ) : null}
      </div>
      <div className="carousel-track" ref={trackRef}>
        {children}
        {count > 1 ? [0, 1].flatMap((copy) => cards.filter((card) => card.props.className === 'carousel-card').map((card) => React.cloneElement(card, { key: `loop-${copy}-${card.key}`, className: 'carousel-card carousel-copy', 'aria-hidden': true, tabIndex: -1 }))) : null}
      </div>
    </div>
  );
}

function Home() {
  const markets = useQuery(marketQueryOptions());
  const listed = publicMarkets(markets.data);
  const imageKey = listed.map((market) => market.address).join(',');
  const images = useQuery({
    queryKey: ['market-images', imageKey],
    queryFn: () => getMarketImages(listed.map((market) => market.address)),
    enabled: listed.length > 0,
    staleTime: 30_000,
  });
  const tokenTrack = useRef(null);

  return (
    <>
      <section className="hero">
        <div>
          <h1 className="hero-headline-art">
            <span className="visually-hidden">A MEME BECOMES A <mark>MARKET.</mark></span>
            <img
              src={`${import.meta.env.BASE_URL}memeverse-headline-v1-1280.webp`}
              srcSet={`${import.meta.env.BASE_URL}memeverse-headline-v1-640.webp 640w, ${import.meta.env.BASE_URL}memeverse-headline-v1-1280.webp 1280w`}
              sizes="(max-width: 800px) calc(100vw - 32px), 650px"
              width="1280" height="559" alt="" aria-hidden="true" fetchPriority="high" decoding="async"
            />
          </h1>
          <p>
            MemeVerse turns a meme into an Arc market. People trade it in USDC. Creator and
            treasury fees settle inside the trade.
          </p>
          <FreeLaunchBadge />
          <div className="hero-actions">
            <NavLink className="btn primary" to="/launch">LAUNCH A MEME →</NavLink>
            <NavLink className="btn secondary" to="/markets">TRADE ONCHAIN →</NavLink>
          </div>
        </div>
        <figure className="hero-art">
          <img
            src={`${import.meta.env.BASE_URL}memeverse-hero-v1-960.webp`}
            srcSet={`${import.meta.env.BASE_URL}memeverse-hero-v1-640.webp 640w, ${import.meta.env.BASE_URL}memeverse-hero-v1-960.webp 960w`}
            sizes="(max-width: 800px) 300px, (max-width: 1120px) 38vw, 410px"
            width="960"
            height="1200"
            fetchPriority="high"
            decoding="async"
            alt="MemeVerse’s pixel mascot waves hello, surrounded by floating lime cubes and a glowing ribbon."
          />
        </figure>
      </section>

      <section className="economy-flow" aria-label="Start in three steps">
        {economySteps.map(([n, label, to, copy]) => {
          const body = (<><span>{n}</span><strong>{label}</strong><p>{copy}</p></>);
          return to.startsWith('https://') ? (
            <a key={n} href={to} target="_blank" rel="noreferrer noopener" className="economy-step">
              {body}<b aria-hidden="true">↗</b>
            </a>
          ) : (
            <NavLink key={n} to={to} className="economy-step">{body}<b aria-hidden="true">→</b></NavLink>
          );
        })}
      </section>

      <HomeActivity listed={listed} images={images.data} />

      <section className="home-collections" aria-label="Live token markets">
        <AssetCarousel
          label="Explore markets"
          detail="Live meme markets on Arc. Explore a token before you trade."
          trackRef={tokenTrack}
          count={listed.length}
        >
          {markets.isPending ? (
            <article className="carousel-card"><div><small>TOKEN</small><strong>Loading markets…</strong></div></article>
          ) : null}
          {markets.isError && listed.length === 0 ? (
            <div className="collection-feedback" role="status"><strong>Markets couldn’t load</strong><p>Check your connection and try again.</p><button className="btn secondary" type="button" disabled={markets.isFetching} onClick={() => markets.refetch()}>{markets.isFetching ? 'RETRYING…' : 'TRY AGAIN →'}</button></div>
          ) : null}
          {!markets.isPending && !markets.isError && listed.length === 0 ? (
            <NavLink className="carousel-card" to="/launch">
              <div className="carousel-fallback"><Mascot small /></div>
              <div><small>TOKEN</small><strong>No tokens yet</strong><em>Launch the first market</em></div>
            </NavLink>
          ) : null}
          {listed.map((market) => (
            <NavLink key={market.address} className="carousel-card" to="/markets">
              <CarouselArt src={mediaContentUrl(images.data?.[market.address]?.url)} alt="" />
              <div>
                <small>TOKEN</small>
                <strong>{market.name}</strong>
                <em>${market.symbol}</em>
                <b>{marketSpotLabel(market, formatUsdc)}</b>
              </div>
            </NavLink>
          ))}
        </AssetCarousel>


      </section>
    </>
  );
}

function activityQueryOptions() {
  return { queryKey: ['activity'], queryFn: () => getActivity(200), staleTime: 10_000, refetchInterval: 15_000 };
}

/**
 * Trending and latest trades, from the server's chain index. Both lists show only recorded
 * trades; a period without any shows an honest empty state instead of zeros.
 */
function HomeActivity({ listed, images }) {
  const activity = useQuery(activityQueryOptions());
  const [chosenPeriod, setChosenPeriod] = useState(null);
  const byAddress = Object.fromEntries(listed.map((market) => [market.address, market]));
  const stats = activity.data?.markets;
  // Until someone picks a period, open on the shortest one that has a real trade.
  const period = chosenPeriod ?? defaultTrendPeriod(listed, stats);
  const trending = trendingMarkets(listed, stats, 5, period);
  const recent = (activity.data?.recent ?? []).filter((trade) => byAddress[trade.market]);
  const anyTrade = recent.length > 0;
  const periodWord = { '24h': 'today', '7d': 'this week', '30d': 'this month', all: 'all time' }[period];
  if (activity.isPending) return null;
  return (
    <section className="home-activity" aria-label="Market activity">
      <div className="activity-panel">
        <header>
          <span><i aria-hidden="true" />TRENDING</span>
          <div className="period-toggle" role="group" aria-label="Trending period">
            {TREND_PERIODS.map(([value, label]) => (
              <button key={value} type="button" aria-pressed={period === value} onClick={() => setChosenPeriod(value)}>{label}</button>
            ))}
          </div>
        </header>
        {trending.length ? (
          <ol className="trending-list">
            {trending.map(({ market, stats: entry, window }, index) => (
              <li key={market.address}>
                <NavLink to="/markets" className="trending-row">
                  <b className="trending-rank">{index + 1}</b>
                  <MarketImage src={mediaContentUrl(images?.[market.address]?.url)} alt="" size="sm" />
                  <span className="trending-name"><strong>{market.name}</strong><small>${market.symbol} · {entry.holders} holder{entry.holders === 1 ? '' : 's'}</small></span>
                  <span className="trending-volume"><strong>{formatDollars(window.volumeUsdc)}</strong><small>{window.trades} trade{window.trades === 1 ? '' : 's'} {periodWord}</small></span>
                </NavLink>
              </li>
            ))}
          </ol>
        ) : anyTrade ? (
          <div className="activity-empty"><strong>Quiet {periodWord}</strong><p>No trades in this period yet. Try a longer range, or make the first move.</p></div>
        ) : (
          <div className="activity-empty"><strong>No trades yet</strong><p>Be the first to buy a meme on Arc. New tokens start from $1.</p><NavLink className="btn primary" to="/markets">EXPLORE MARKETS →</NavLink></div>
        )}
      </div>
      <div className="activity-panel">
        <header><span><i aria-hidden="true" />LATEST TRADES</span><small>{recent.length ? `${recent.length} TRADE${recent.length === 1 ? '' : 'S'}` : 'ONCHAIN'}</small></header>
        {recent.length ? (
          <ul className="trade-feed" tabIndex={0} aria-label="All trades, newest first">
            {recent.map((trade) => {
              const market = byAddress[trade.market];
              return (
                <li key={`${trade.tx}-${trade.market}-${trade.side}`}>
                  <MarketImage src={mediaContentUrl(images?.[trade.market]?.url)} alt="" size="sm" />
                  <p>
                    <span className="trade-trader">{shortTrader(trade.trader)}</span>{' '}
                    <b className={trade.side === 'BUY' ? 'trade-buy' : 'trade-sell'}>{trade.side === 'BUY' ? 'bought' : 'sold'}</b>{' '}
                    <strong>{formatDollars(trade.usdc)}</strong> of <strong>${market.symbol}</strong>
                  </p>
                  <ExternalLink href={`${arcLinks.explorer}/tx/${trade.tx}`} className="trade-time" aria-label={`View transaction, ${timeAgo(trade.at)}`}>{timeAgo(trade.at)} ↗</ExternalLink>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="activity-empty"><strong>Waiting for the first trade</strong><p>Every buy and sell shows up here, straight from the chain.</p></div>
        )}
      </div>
    </section>
  );
}

function CarouselArt({ src, alt }) {
  return <div className="carousel-art"><MarketImage src={src} alt={alt} /></div>;
}

/**
 * Hosting this application requires SPA history fallback, so a mistyped path arrives in the
 * browser as a successful page load. Say so, and put the demo path back within one click.
 */
function NotFound() {
  return (
    <section className="page not-found">
      <Title n="404" t="PAGE NOT FOUND" />
      <p className="lede">
        We couldn’t find that page. Choose a section below to continue.
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

/** Launching charges no platform fee; the creator pays only Arc network gas, in USDC. */
function FreeLaunchBadge({ className = '' }) {
  return (
    <div className={`free-launch ${className}`.trim()} role="note" aria-label="No launch fee">
      <span className="free-launch-price" aria-hidden="true">$0</span>
      <span className="free-launch-copy">
        <b>Launch fee</b>
        <small>Only network gas, a few cents in USDC. Earn 1% of every trade.</small>
      </span>
    </div>
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
  const slopePrice = '0.001';
  const [review, setReview] = useState(false);
  const [result, setResult] = useState(null);
  const [formError, setFormError] = useState(null);
  const { address, isConnected, onArc } = useArcNetwork();
  const action = useOnchainAction();
  /*
    The image is entirely separate from the launch. It is chosen before signing purely so the
    creator can see what they are making. The UI requires a selected image, while the image stays
    outside `createMarket` calldata and is attached only after Arc has confirmed the market.
  */
  const image = useImageSelection();
  const launchImageRef = useRef(null);
  const attach = useMediaUpload({
    action: MEDIA_ACTIONS.MARKET_AVATAR,
    market: result?.market,
    selection: image.selection,
    onUploaded: () => {
      // The new market's artwork, and the market list it will appear in.
      queryClient.invalidateQueries({ queryKey: ['market-images'] });
      queryClient.invalidateQueries({ queryKey: ['onchain-markets'] });
    },
  });

  const walletIsCreator = Boolean(address && result?.creator
    && address.toLowerCase() === result.creator.toLowerCase());

  /*
    Attach the chosen artwork automatically, once, as soon as the market it belongs to exists.

    The creator picked the file before launching, so asking them to pick it again afterwards was
    busywork. What makes this safe to automate is that nothing about the security model moves: the
    market address comes from the confirmed `MarketCreated` event rather than from guessing or
    polling, and the wallet still signs a real authorization bound to that exact address, these
    exact bytes, and a short expiry. The only thing removed is the click.

    Idempotency is the whole difficulty here. `attach.start` is a new function on every render (it
    closes over the upload state and an inline `onUploaded`), so an effect that depended on it
    would re-run constantly and could open a second wallet prompt. Instead the effect depends only
    on values, calls the latest `start` through a ref, and records the market+hash pair it has
    already fired for — which also makes it inert under StrictMode's double-invoked effects, a
    re-render, a query refetch, or a market-list refresh.
  */
  const startAttachRef = useRef(attach.start);
  useEffect(() => { startAttachRef.current = attach.start; });

  const autoAttachKey = result?.market && image.selection?.contentHash
    ? `${result.market}|${image.selection.contentHash}`
    : null;
  const autoAttachedRef = useRef(null);

  useEffect(() => {
    if (!autoAttachKey) return;
    // Already fired for this exact market and these exact bytes.
    if (autoAttachedRef.current === autoAttachKey) return;
    // Never prompt a wallet that the market does not name as its creator: the signature could not
    // authorize anything, and signing under the wrong account is precisely what must not happen
    // silently. The retry control covers reconnecting the right one.
    if (!walletIsCreator) return;
    autoAttachedRef.current = autoAttachKey;
    startAttachRef.current?.();
  }, [autoAttachKey, walletIsCreator]);

  const artworkStage = launchArtworkStage({
    hasSelection: Boolean(image.selection),
    launched: Boolean(result?.market),
    walletMatchesCreator: walletIsCreator,
    status: attach.state.status,
  });

  /** Retry reuses the selection already in memory — never a second file pick, never a second launch. */
  function retryArtwork() {
    if (!autoAttachKey || !walletIsCreator) return;
    autoAttachedRef.current = autoAttachKey;
    startAttachRef.current?.();
  }
  const factory = useQuery({
    queryKey: ['market-factory-config'],
    queryFn: loadFactoryConfig,
    retry: 1,
  });

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
    || supplyValue === null || basePriceUnits === null || slopePriceUnits === null || !image.selection;

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
                : slopePriceUnits === null ? 'Curve increase must be between 0 and 1000 USDC, with at most 6 decimals.'
                  : 'Choose a token image using the preview card before continuing.',
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
      <Title n="01 / CREATE" t="LAUNCH A MARKET" />
      <p className="lede">Create a meme market on Arc with your wallet. Set its supply and USDC pricing, review the transaction, then confirm it onchain.</p>
      <FreeLaunchBadge className="free-launch-page" />
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
              type="text"
              inputMode="numeric"
              required
            />
          </label>
          <label>
            STARTING PRICE (USDC)
            <input
              value={basePrice}
              onChange={(event) => setBasePrice(event.target.value)}
              type="text"
              inputMode="decimal"
              required
            />
          </label>
          <p className="launch-price-note">The price increases automatically as tokens sell. Your starting price excludes trading fees.</p>
          <label>
            DESCRIPTION
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength="280" placeholder="What makes this meme worth trading?" />
          </label>
          <div className="receive">
            <span>FIXED ONCHAIN SUPPLY</span>
            <b>{supplyValue === null ? '—' : supplyValue.toLocaleString()} ${symbol || 'TOKEN'}</b>
          </div>
          <button className="btn primary full" disabled={action.state.status === 'WALLET_SIGNATURE' || action.state.status === 'SUBMITTED'}>REVIEW ONCHAIN LAUNCH →</button>
          {formError ? <small className="tx-error" role="alert">{formError}</small> : null}
          {review ? <div className="launch-wallet-access">{!isConnected ? <div className="trade-wallet"><p>Connect your wallet to launch your market.</p><Wallet /></div> : null}<NetworkStatus /></div> : null}
          {review ? <div className="onchain-review" role="region" aria-label="Launch review"><b>REVIEW BEFORE SIGNING</b><span>CREATOR // {address ?? 'CONNECT WALLET'}</span><span>FACTORY // {arcContracts.memeVerseFactory}</span><span>STARTING PRICE // {basePrice} USDC</span><span>PRICING // INCREASES AS TOKENS SELL</span><span>LAUNCH FEE // 0 USDC · NETWORK GAS ONLY</span><span>TRADING FEES // {factory.data ? `${Number(factory.data.creatorFeeBps) / 100}% CREATOR + ${Number(factory.data.treasuryFeeBps) / 100}% TREASURY` : 'READING ONCHAIN'}</span><button className="btn primary full" type="button" disabled={!onArc || !factory.data || ['WALLET_SIGNATURE', 'SUBMITTED'].includes(action.state.status)} onClick={launchMarket}>{!isConnected ? 'CONNECT WALLET FIRST' : !onArc ? (ARC_IS_MAINNET ? 'SWITCH TO ARC MAINNET' : 'SWITCH TO ARC TESTNET') : 'SIGN + LAUNCH ON ARC →'}</button></div> : null}
          <TransactionStatus state={action.state} />
          {result ? <div className="receipt onchain-receipt" role="status"><b>MARKET CONFIRMED ON ARC</b><span>MARKET + TOKEN // {result.market}</span><span>CREATOR // {result.creator}</span><ExternalLink href={`${arcLinks.explorer}/tx/${result.hash}`}>VIEW TRANSACTION ON ARCSCAN ↗</ExternalLink><ExternalLink href={`${arcLinks.explorer}/address/${result.market}`}>VIEW MARKET CONTRACT ↗</ExternalLink></div> : null}
          {/*
            The artwork outcome, reported separately from the launch above it.

            The market is already live on Arc by the time anything here renders, and nothing in
            this block can change that — a declined signature, a failed upload, or a closed tab
            leaves a launched market with no artwork, which is a complete and valid result.
          */}
          {artworkStage !== 'NONE' ? (
            <div
              className={`attach-image ${artworkStage === 'ATTACHED' ? 'ok' : ''}`}
              role="status"
              aria-live="polite"
              aria-label="Market artwork"
            >
              <b>
                {artworkStage === 'ATTACHED' ? 'MARKET LAUNCHED // ARTWORK ATTACHED'
                  : artworkStage === 'FAILED' ? 'MARKET LAUNCHED // ARTWORK NOT ATTACHED'
                    : artworkStage === 'WRONG_WALLET' ? 'MARKET LAUNCHED // ARTWORK PENDING'
                      : artworkStage === 'UPLOADING' ? 'UPLOADING ARTWORK…'
                        : artworkStage === 'SIGNING' ? 'CHECK YOUR WALLET — ATTACH ARTWORK'
                          : 'ATTACHING ARTWORK…'}
              </b>
              <span>
                {artworkStage === 'ATTACHED'
                  ? 'Your image is attached to the new market and will appear wherever it is shown.'
                  : artworkStage === 'FAILED'
                    // The headline above already states the market launched, and some error
                    // messages say so themselves, so this must not repeat it a third time.
                    ? `${attach.state.error ?? 'The image could not be attached.'} Retry below using the same selected image.`
                    : artworkStage === 'WRONG_WALLET'
                      ? `Connected wallet is not this market’s creator. Reconnect ${shortAddress(result.creator)} to attach the selected image.`
                      : 'Attaching the image you selected is a free wallet signature — no gas, no transaction, and it moves no funds.'}
              </span>
              {canRetryLaunchArtwork(artworkStage) ? (
                <button
                  type="button"
                  className="btn secondary full"
                  disabled={!onArc || !walletIsCreator}
                  onClick={retryArtwork}
                >
                  RETRY ARTWORK →
                </button>
              ) : null}
            </div>
          ) : null}
        </form>
        <aside className="spec launch-preview" aria-label="Live token preview">
          <span className="eyebrow">YOUR TOKEN / LIVE PREVIEW</span>
          <article className="launch-token-card">
            <button type="button" className="launch-artwork-picker" disabled={Boolean(result?.market)} onClick={() => launchImageRef.current?.click()} aria-label="Choose token artwork">
              <MarketImage src={image.selection?.previewUrl} alt="Token preview artwork" />
            </button>
            <button type="button" className="btn launch-upload-button" disabled={Boolean(result?.market)} onClick={() => launchImageRef.current?.click()} aria-label="Upload token image">UPLOAD TOKEN IMAGE ↗</button>
            <input ref={launchImageRef} id="launch-market-image" type="file" accept="image/png,image/jpeg,image/webp" disabled={Boolean(result?.market)} hidden onChange={(event) => { image.select(event.target.files?.[0] ?? null); setReview(false); setFormError(null); }} />
            <p className="launch-image-hint">Click the image above to upload your token image. <b>Required.</b><small>PNG, JPEG or WebP · Up to 5 MB</small></p>
            {image.error ? <p className="inline-error" role="alert">{image.error}</p> : null}
            <div className="launch-token-details">
              <small>${symbol.trim().toUpperCase() || 'TICKER'}</small>
              <h2>{name.trim() || 'Your meme name'}</h2>
              <strong>{basePriceUnits === null ? '—' : formatUsdc(basePriceUnits)} USDC <span>/ TOKEN</span></strong>
              {description.trim() ? <p>{description.trim()}</p> : <p>Your token’s story will appear here.</p>}
              <dl><div><dt>TOTAL SUPPLY</dt><dd>{supplyValue === null ? '—' : supplyValue.toLocaleString()}</dd></div><div><dt>NETWORK</dt><dd>{network.chain.name}</dd></div></dl>
              <span className="launch-preview-label">TOKEN CARD PREVIEW</span>
            </div>
          </article>
          <p className="launch-upload-note">Your selected image is attached after the launch confirms, using a free wallet signature. Once attached, it cannot be replaced.</p>
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

/** One button for the whole onchain flow, plus a single status line beneath it. */
function TradeAction({ button, line }) {
  return (
    <div className="trade-action">
      <button className={`btn primary full trade-cta${button.busy ? ' busy' : ''}`} disabled={button.busy || button.disabled} aria-busy={button.busy}>
        {button.busy ? <i className="trade-spinner" aria-hidden="true" /> : null}{button.label}
      </button>
      {button.progress ? <p className="trade-progress">{button.progress}</p> : null}
      <p className={`trade-line ${line?.tone ?? ''}`} role="status" aria-live="polite">
        {line ? <>{line.tone === 'done' ? <b aria-hidden="true">✓</b> : null}<span>{line.text}</span>{line.hash ? <ExternalLink href={`${arcLinks.explorer}/tx/${line.hash}`}>View transaction ↗</ExternalLink> : null}</> : null}
      </p>
    </div>
  );
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function Markets() {
  const { address, isConnected, onArc } = useArcNetwork();
  const [selectedAddress, setSelectedAddress] = useState(null);
  const [tradeOpen, setTradeOpen] = useState(false);
  const tradeDialogRef = useRef(null);
  const [side, setSide] = useState('BUY');
  const [buyAmount, setBuyAmount] = useState('1');
  const [sellAmount, setSellAmount] = useState('1');
  const [boardQuery, setBoardQuery] = useState('');
  const [boardSort, setBoardSort] = useState('newest');
  const [positionView, setPositionView] = useState('all');
  const hasFilters = Boolean(boardQuery || positionView !== 'all');
  const slippageBps = 100;
  const markets = useQuery(marketQueryOptions(address));
  const usdcBalance = useQuery({
    queryKey: ['wallet-usdc', address],
    queryFn: () => loadUsdcBalance(address),
    enabled: onArc,
    staleTime: 12_000,
    refetchInterval: 12_000,
  });
  /*
    What this page browses: every registered market except the project's own legacy test markets.
    The full factory result stays in `markets.data` and is untouched — this is the presentation
    view of it. Positions and creator filters use the connected wallet's onchain data.
  */
  const visibleMarkets = useMemo(() => publicMarkets(markets.data), [markets.data]);
  const boardMarkets = useMemo(() => {
    const filtered = filterTradeableMarkets(visibleMarkets, { query: boardQuery, onlyHeld: positionView === 'held', createdBy: positionView === 'created' ? address : null });
    return sortTradeableMarkets(filtered, boardSort);
  }, [visibleMarkets, boardQuery, boardSort, positionView, address]);
  const visibleAddresses = boardMarkets.map((market) => market.address).join(',');

  /*
    Artwork for every listed market, in one request rather than one per row. Deliberately a
    separate query from the market data: if media is slow or down, prices, reserves, and quotes
    still render on time and the rows simply show the mark.
  */
  const marketImages = useQuery({
    queryKey: ['market-images', visibleAddresses],
    queryFn: () => getMarketImages(boardMarkets.map((market) => market.address)),
    enabled: boardMarkets.length > 0,
    staleTime: 30_000,
  });
  const imageFor = (market) => mediaContentUrl(marketImages.data?.[market?.address]?.url);

  const selected = boardMarkets.find((market) => market.address === selectedAddress) ?? null;
  /*
    The board is only the cards. A market is selected when Buy or Sell opens the trade dialog,
    and that selection is dropped if a filter removes the contract while the dialog is up.
  */
  useEffect(() => {
    if (!selectedAddress) return;
    const stillVisible = boardMarkets.some((market) => market.address === selectedAddress);
    if (!stillVisible) {
      setSelectedAddress(null);
      setTradeOpen(false);
    }
  }, [visibleAddresses, selectedAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!tradeOpen) return undefined;
    const trigger = document.activeElement;
    const background = document.getElementById('root');
    const previousInert = background.inert;
    const previousOverflow = document.body.style.overflow;
    background.inert = true;
    document.body.style.overflow = 'hidden';
    tradeDialogRef.current?.focus();
    function onKey(event) {
      if (event.key === 'Escape') setTradeOpen(false);
      if (event.key !== 'Tab') return;
      const panel = tradeDialogRef.current;
      // Reown opens its own portal above this sheet and owns focus while it is open.
      if (!panel?.contains(event.target)) return;
      const controls = [...panel.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')]
        .filter((node) => node.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) { event.preventDefault(); panel.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      background.inert = previousInert;
      document.removeEventListener('keydown', onKey);
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [tradeOpen]);

  let buyUnits = 0n;
  let sellUnits = 0n;
  let buyInputError = null;
  let sellInputError = null;
  try { buyUnits = parseUsdc(buyAmount); } catch (error) { buyInputError = error.message; }
  try { sellUnits = parseTokenAmount(sellAmount, { fractional: selected?.tradingVersion === 2 }); } catch (error) { sellInputError = error.message; }

  const settledBuyUnits = useDebouncedValue(buyUnits);
  const settledSellUnits = useDebouncedValue(sellUnits);
  const buyQuoteResult = useQuery({
    queryKey: ['market-buy-quote', selected?.address, settledBuyUnits.toString()],
    queryFn: () => quoteBuy(selected.address, settledBuyUnits),
    enabled: Boolean(tradeOpen && side === 'BUY' && selected && settledBuyUnits > 0n && settledBuyUnits === buyUnits),
    retry: 1,
    refetchInterval: 8_000,
  });
  const sellQuoteResult = useQuery({
    queryKey: ['market-sell-quote', selected?.address, settledSellUnits.toString()],
    queryFn: () => quoteSell(selected.address, settledSellUnits),
    enabled: Boolean(tradeOpen && side === 'SELL' && selected && settledSellUnits > 0n && settledSellUnits === sellUnits),
    retry: 1,
    refetchInterval: 8_000,
  });
  // Never display or submit a quote for the amount that was in the field before this edit.
  const buyQuote = { ...buyQuoteResult, data: settledBuyUnits === buyUnits && !buyQuoteResult.isError ? buyQuoteResult.data : undefined };
  const sellQuote = { ...sellQuoteResult, data: settledSellUnits === sellUnits && !sellQuoteResult.isError ? sellQuoteResult.data : undefined };
  const approval = useOnchainAction();
  const buy = useOnchainAction();
  const sell = useOnchainAction();
  const [buyStep, setBuyStep] = useState(null);
  const [sellStep, setSellStep] = useState(null);
  const walletStateLoading = onArc && markets.isPlaceholderData;
  const allowanceRequired = Boolean(selected && buyQuote.data?.[0] > 0n && buyUnits > selected.usdcAllowance);
  const minimumBuyUsdc = marketMinimumBuyUsdc(selected);
  // Legacy (v1) markets sell whole tokens only, so a budget below one token quotes zero.
  const lowUsdc = needsMoreUsdc({ onArc, balance: usdcBalance.data, budget: buyUnits });
  const wholeTokenOnlyZero = Boolean(selected && selected.tradingVersion !== 2 && buyQuote.data && buyQuote.data[0] === 0n && buyUnits > 0n);
  const availability = marketAvailability(selected);

  function openTrade(address, nextSide) {
    setSelectedAddress(address);
    setSide(nextSide);
    setTradeOpen(true);
  }

  async function refreshMarketState() {
    await Promise.all([
      markets.refetch(),
      usdcBalance.refetch(),
      queryClient.invalidateQueries({ queryKey: ['market-buy-quote'] }),
      queryClient.invalidateQueries({ queryKey: ['market-sell-quote'] }),
    ]);
  }

  /**
   * One click runs the whole buy: an exact USDC allowance when needed, then the buy itself, using
   * the quote the person saw. A failed buy after a successful allowance resumes at the buy.
   */
  async function buyTokens(event) {
    event.preventDefault();
    if (buyStep || !onArc || walletStateLoading || !selected || !buyQuote.data || buyQuote.data[0] === 0n || buyUnits <= 0n) return;
    const market = selected.address;
    const units = buyUnits;
    const quote = buyQuote.data;
    approval.reset();
    buy.reset();
    try {
      if (allowanceRequired) {
        setBuyStep('approve');
        await approval.execute({ address: arcContracts.usdc, abi: usdcAbi, functionName: 'approve', args: [market, units], chainId: arc.id });
      }
      setBuyStep('trade');
      await buy.execute({ address: market, abi: marketAbi, functionName: 'buy', args: [units, minimumAfterSlippage(quote[0], slippageBps)], chainId: arc.id });
    } catch { /* The status line presents the wallet/provider error. */ }
    setBuyStep(null);
    await refreshMarketState();
  }

  async function sellTokens(event) {
    event.preventDefault();
    if (sellStep || !onArc || walletStateLoading || !selected || !sellQuote.data || sellUnits <= 0n || sellUnits > selected.userBalance) return;
    sell.reset();
    setSellStep('trade');
    try {
      await sell.execute({
        address: selected.address,
        abi: marketAbi,
        functionName: 'sell',
        args: [sellUnits, minimumAfterSlippage(sellQuote.data[0], slippageBps)],
        chainId: arc.id,
      });
    } catch { /* The status line presents the wallet/provider error. */ }
    setSellStep(null);
    await refreshMarketState();
  }

  return (
    <section className="page markets-page">
      <Title n="02 / TRADE" t="EXPLORE MARKETS" />
      <p className="lede">
        Explore meme markets on Arc, check live USDC prices, and trade from your wallet.
        Quotes, positions, and fees come directly from the blockchain.
      </p>
      <div className="market-toolbar">
        <label className="market-search">
          SEARCH
          <input
            value={boardQuery}
            onChange={(event) => setBoardQuery(event.target.value)}
            placeholder="Name, ticker, or 0x address"
            type="search"
          />
        </label>
        <label>
          SORT
          <select value={boardSort} onChange={(event) => setBoardSort(event.target.value)}>
            <option value="newest">Newest onchain</option>
            <option value="reserve">Highest USDC reserve</option>
            <option value="sold">Most sold</option>
          </select>
        </label>
        <label>
          YOUR MARKETS
          <select value={positionView} onChange={(event) => setPositionView(event.target.value)}>
            <option value="all">All markets</option>
            <option value="created" disabled={!isConnected}>Launched by me</option>
            <option value="held" disabled={!isConnected}>My holdings</option>
          </select>
        </label>
      </div>
      {positionView !== 'all' ? <p className="market-view-hint">{positionView === 'created' ? 'Markets launched from your connected wallet.' : 'Tokens you currently hold, including tokens from your own launches.'}</p> : null}
      <div className="market-results" role="status" aria-live="polite">
        <span>{markets.isPending ? 'Reading markets from Arc…' : `${boardMarkets.length} ${boardMarkets.length === 1 ? 'market' : 'markets'}${hasFilters ? ' match your filters' : ' on this board'}`}</span>
        {markets.isFetching && !markets.isPending ? <span>Updating…</span> : null}
      </div>
      {markets.isError ? <div className="inline-error" role="alert">{markets.data ? 'Live update failed. Showing the last loaded market data.' : 'Couldn’t reach Arc. Check your connection and retry.'} <button className="btn secondary" type="button" disabled={markets.isFetching} onClick={() => markets.refetch()}>{markets.isFetching ? 'RETRYING…' : 'TRY AGAIN'}</button></div> : null}
      {markets.isPending && !boardMarkets.length ? (
        <div className="market-board market-skeletons" aria-hidden="true">{[0, 1, 2].map((key) => <div className="market-card market-skeleton" key={key}><div /><span /><span /><span /></div>)}</div>
      ) : null}
      {!markets.isPending && !markets.isError && !boardMarkets.length ? (
        <div className="empty market-empty"><Mascot small /><strong>{hasFilters ? 'No markets match your filters' : 'No markets yet'}</strong><p>{hasFilters ? 'Try a different name, ticker, or address.' : 'Create a market to start trading on Arc.'}</p>{hasFilters ? <button className="btn secondary" type="button" onClick={() => { setBoardQuery(''); setPositionView('all'); }}>CLEAR FILTERS</button> : <NavLink className="btn primary" to="/launch">LAUNCH A MARKET →</NavLink>}</div>
      ) : null}
      {boardMarkets.length ? (
        <div className="market-board" role="list" aria-label="Onchain markets">
          {boardMarkets.map((market) => {
            const sold = marketSoldPercent(market);
            const active = tradeOpen && selected?.address === market.address;
            return (
              <article key={market.address} className={`market-card ${active ? 'active' : ''}`} role="listitem">
                <div className="market-card-hit">
                  <div className="market-card-art">
                    <MarketImage src={imageFor(market)} alt={`${market.symbol} artwork`} size="md" />
                  </div>
                  <div className="market-card-body">
                    <small>{market.symbol}</small>
                    <strong>{market.name}</strong>
                    <b>{marketSpotPerTokenLabel(market, formatUsdc)}</b>
                    <span className="sold-meter" aria-hidden="true"><i style={{ width: `${sold}%` }} /></span>
                    <em>{formatTokenAmount(market.soldTokenUnits, 6)} / {market.totalSupplyTokens.toLocaleString()} sold · {formatUsdc(market.reserveUsdc)} USDC reserve</em>
                  </div>
                </div>
                <div className="market-card-actions">
                  <button type="button" className="btn primary" onClick={() => openTrade(market.address, 'BUY')}>BUY</button>
                  <button type="button" className="btn" onClick={() => openTrade(market.address, 'SELL')}>SELL</button>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
      {tradeOpen && selected ? createPortal(
        <div className="trade-modal" onMouseDown={(event) => { if (event.target === event.currentTarget) setTradeOpen(false); }}>
          <div
            className="trade-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trade-modal-title"
            tabIndex={-1}
            ref={tradeDialogRef}
          >
            <button type="button" className="trade-modal-close" aria-label="Close trade panel" onClick={() => setTradeOpen(false)}>✕ <span>Close</span></button>
            <div className="trade-modal-scroll">
            <div className="market-terminal">
              <section className="market-proof">
                <div className="market-identity">
                  <MarketImage src={imageFor(selected)} alt={`${selected.symbol} artwork`} size="md" />
                  <div>
                    <small>MARKET DETAILS</small>
                    <strong id="trade-modal-title">{selected.name} <span>/ ${selected.symbol}</span></strong>
                    <ExternalLink href={`${arcLinks.explorer}/address/${selected.address}`}>{shortAddress(selected.address)} ↗</ExternalLink>
                  </div>
                </div>
                <dl>
                  <dt>LIVE BUY PRICE</dt><dd>{marketBuyPriceLabel(selected, formatUsdc)}<small className="price-fee-note">Per token · includes fees</small></dd>
                  <dt>USDC IN MARKET</dt><dd>{formatUsdc(selected.reserveUsdc)} USDC</dd>
                  <dt>SUPPLY SOLD</dt><dd>{formatTokenAmount(selected.soldTokenUnits, 6)} / {selected.totalSupplyTokens.toLocaleString()}</dd>
                  <dt>CREATOR</dt><dd>{shortAddress(selected.creator)}</dd>
                  <dt>CREATOR FEES</dt><dd>{formatUsdc(selected.creatorFeesPaidUsdc)} USDC</dd>
                  <dt>TREASURY FEES</dt><dd>{formatUsdc(selected.treasuryFeesPaidUsdc)} USDC</dd>
                  <dt>YOUR POSITION</dt><dd>{formatTokenAmount(selected.userBalance, 6)} {selected.symbol}</dd>
                </dl>
                {marketDescriptionForDisplay(selected) ? <p>{marketDescriptionForDisplay(selected)}</p> : null}
              </section>
              <section className="market-order">
                {!isConnected ? <div className="trade-wallet"><p>Connect your wallet to trade this market.</p><Wallet /></div> : null}
                <NetworkStatus />
                {walletStateLoading ? <p className="quote-feedback" role="status">Reading your wallet balances and allowances…</p> : null}
                <div className="tabs" role="group" aria-label="Trade direction"><button type="button" aria-pressed={side === 'BUY'} className={side === 'BUY' ? 'active' : ''} onClick={() => setSide('BUY')}>BUY</button><button type="button" aria-pressed={side === 'SELL'} className={side === 'SELL' ? 'active sell' : ''} onClick={() => setSide('SELL')}>SELL</button></div>
                {side === 'BUY' && availability.soldOut ? (
                  <div className="trade-review sold-out" role="status">
                    <span>BUY AVAILABILITY <b>SOLD OUT</b></span>
                    <span>SUPPLY <b>{formatTokenAmount(selected.soldTokenUnits, 6)} / {selected.totalSupplyTokens.toLocaleString()} SOLD</b></span>
                    <span>CURVE RESERVE <b>{formatUsdc(selected.reserveUsdc)} USDC</b></span>
                    <span>The complete fixed supply is circulating, so this market has no next token to price. Selling back to the curve reserve remains available.</span>
                  </div>
                ) : side === 'BUY' ? <form onSubmit={buyTokens}>
                  <label>MAX USDC TO SPEND<input value={buyAmount} onChange={(event) => setBuyAmount(event.target.value)} type="text" inputMode="decimal" required /><small>USDC</small></label>
                  <div className="quick-amounts" role="group" aria-label="Quick amounts">
                    {QUICK_BUY_AMOUNTS.map((amount) => (
                      <button key={amount} type="button" aria-pressed={buyAmount === amount} onClick={() => setBuyAmount(amount)}>${amount}</button>
                    ))}
                  </div>
                  <label className="quote-output">YOU RECEIVE (ESTIMATED)<input readOnly value={buyQuote.data ? formatTokenAmount(buyQuote.data[0], 6) : '—'} aria-label="Estimated tokens received" /><small>{selected.symbol}</small></label>
                  {lowUsdc ? (
                    <div className="fund-usdc" role="status">
                      <div><b>Not enough USDC on Arc</b><span>Your wallet holds {formatUsdc(usdcBalance.data)} USDC. {ARC_IS_MAINNET ? 'Bridge more from Base or another chain with Relay' : 'Claim test USDC from the Circle faucet'}, then come back to buy.</span></div>
                      <a className="btn primary" href={FUNDING.href} target="_blank" rel="noreferrer noopener">{FUNDING.label} ↗</a>
                    </div>
                  ) : (
                    <a className="fund-link" href={FUNDING.href} target="_blank" rel="noreferrer noopener">Need USDC on Arc? <b>{ARC_IS_MAINNET ? 'Bridge in with Relay' : 'Get test USDC from the Circle faucet'} ↗</b></a>
                  )}
                  {wholeTokenOnlyZero ? <p className="whole-token-note" role="status">{selected.symbol} trades in whole tokens only. One token costs {formatUsdc(minimumBuyUsdc)} USDC with fees.</p> : null}
                  <details className="trade-details" key={`${selected.address}-buy`}><summary>TRADE DETAILS <span>Fees, limits & wallet balance</span></summary>
                  <div className="trade-review">
                    <span>WALLET BALANCE <b>{onArc && usdcBalance.data !== undefined ? `${formatUsdc(usdcBalance.data)} USDC` : 'CONNECT ON ARC'}</b></span>
                    <span>MAX INPUT <b>{buyAmount || '0'} USDC</b></span>
                    <span>ESTIMATED SPEND <b>{buyQuote.data ? `${formatUsdc(buyQuote.data[4])} USDC` : '—'}</b></span>
                    <span>ESTIMATED OUT <b>{buyQuote.data ? `${formatTokenAmount(buyQuote.data[0], 6)} ${selected.symbol}` : '—'}</b></span>
                    <span>CURVE COST <b>{buyQuote.data ? `${formatUsdc(buyQuote.data[1])} USDC` : '—'}</b></span>
                    <span>CREATOR ALLOCATION <b>{buyQuote.data ? `${formatUsdc(buyQuote.data[2])} USDC` : '—'}</b></span>
                    <span>TREASURY ALLOCATION <b>{buyQuote.data ? `${formatUsdc(buyQuote.data[3])} USDC` : '—'}</b></span>
                    <span>MINIMUM OUT / SLIPPAGE <b>{buyQuote.data ? `${formatTokenAmount(minimumAfterSlippage(buyQuote.data[0], slippageBps), 2)} / 1%` : '—'}</b></span>
                    <span>CREATOR FEE RATE <b>{Number(selected.creatorFeeBps) / 100}%</b></span>
                    <span>TREASURY FEE RATE <b>{Number(selected.treasuryFeeBps) / 100}%</b></span>
                    <span>BASE PRICE / TOKEN <b>{marketSpotLabel(selected, formatUsdc)}</b></span>
                    <span>BUY PRICE WITH FEES <b>{minimumBuyUsdc === null ? '—' : `${formatUsdc(minimumBuyUsdc)} USDC`}</b></span>
                    <span>NETWORK <b>{network.chain.name}</b></span>
                    <span>UNSPENT MAX INPUT <b>{buyQuote.data ? `${formatUsdc(buyUnits - buyQuote.data[4])} USDC` : '—'}</b></span>
                  </div></details>
                  {buyInputError ? <p className="inline-error">{buyInputError}</p> : null}
                  {!buyInputError && buyUnits > 0n && !buyQuote.data ? <p className="quote-feedback" role="status">{buyQuoteResult.isError ? 'Quote unavailable. Check your connection or try another amount.' : 'Updating your buy quote…'}</p> : null}
                  <TradeAction
                    button={tradeButtonState({ side: 'BUY', step: buyStep, needsApproval: allowanceRequired && onArc, approval: approval.state, action: buy.state, ready: onArc && !walletStateLoading && Boolean(buyQuote.data) && buyQuote.data[0] > 0n })}
                    line={tradeStatusLine({ side: 'BUY', step: buyStep, needsApproval: allowanceRequired && onArc, approval: approval.state, action: buy.state })}
                  />
                </form> : <form onSubmit={sellTokens}>
                  <label>TOKEN AMOUNT<input value={sellAmount} onChange={(event) => setSellAmount(event.target.value)} type="text" inputMode={selected.tradingVersion === 2 ? "decimal" : "numeric"} required /><small>{selected.symbol}</small></label>
                  {onArc && selected.userBalance > 0n ? (
                    <div className="sell-holding">
                      <span>You hold <b>{formatTokenAmount(selected.userBalance, 6)} {selected.symbol}</b></span>
                      <div className="quick-amounts" role="group" aria-label="Sell presets">
                        {SELL_PRESETS.map(([label, numerator, denominator]) => {
                          const value = sellPresetAmount(selected.userBalance, numerator, denominator, selected.tradingVersion === 2);
                          return <button key={label} type="button" disabled={!value} aria-pressed={Boolean(value) && sellAmount === value} onClick={() => setSellAmount(value)}>{label}</button>;
                        })}
                      </div>
                    </div>
                  ) : null}
                  <label className="quote-output">YOU RECEIVE (ESTIMATED)<input readOnly value={sellQuote.data ? formatUsdc(sellQuote.data[0]) : '—'} aria-label="Estimated USDC received" /><small>USDC</small></label>
                  <details className="trade-details" key={`${selected.address}-sell`}><summary>TRADE DETAILS <span>Fees, limits & wallet balance</span></summary>
                  <div className="trade-review">
                    <span>YOUR POSITION <b>{formatTokenAmount(selected.userBalance, 6)} {selected.symbol}</b></span>
                    <span>GROSS CURVE RETURN <b>{sellQuote.data ? `${formatUsdc(sellQuote.data[1])} USDC` : '—'}</b></span>
                    <span>CREATOR ALLOCATION <b>{sellQuote.data ? `${formatUsdc(sellQuote.data[2])} USDC` : '—'}</b></span>
                    <span>TREASURY ALLOCATION <b>{sellQuote.data ? `${formatUsdc(sellQuote.data[3])} USDC` : '—'}</b></span>
                    <span>ESTIMATED RECEIVE <b>{sellQuote.data ? `${formatUsdc(sellQuote.data[0])} USDC` : '—'}</b></span>
                    <span>MINIMUM OUT / SLIPPAGE <b>{sellQuote.data ? `${formatUsdc(minimumAfterSlippage(sellQuote.data[0], slippageBps))} / 1%` : '—'}</b></span>
                    <span>CREATOR FEE RATE <b>{Number(selected.creatorFeeBps) / 100}%</b></span>
                    <span>TREASURY FEE RATE <b>{Number(selected.treasuryFeeBps) / 100}%</b></span>
                    <span>NETWORK <b>{network.chain.name}</b></span>
                  </div></details>
                  {sellInputError ? <p className="inline-error">{sellInputError}</p> : null}
                  {!sellInputError && sellUnits > 0n && !sellQuote.data ? <p className="quote-feedback" role="status">{sellQuoteResult.isError ? 'Quote unavailable. Check your connection or try another amount.' : 'Updating your sell quote…'}</p> : null}
                  {sellUnits > selected.userBalance && onArc ? <p className="inline-error">This amount exceeds your token balance.</p> : null}
                  <TradeAction
                    button={tradeButtonState({ side: 'SELL', step: sellStep, needsApproval: false, action: sell.state, ready: onArc && !walletStateLoading && Boolean(sellQuote.data) && sellQuote.data[0] > 0n && sellUnits <= selected.userBalance })}
                    line={tradeStatusLine({ side: 'SELL', step: sellStep, action: sell.state })}
                  />
                </form>}
              </section>
            </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}

const rootElement = document.getElementById('root');
function bootApplication() {
  const retryButton = rootElement.querySelector('button');
  if (retryButton) { retryButton.disabled = true; retryButton.textContent = 'CHECKING ARC…'; }
  return assertBrowserReadChain()
  .then(() => {
    createRoot(rootElement).render(
      <React.StrictMode>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter basename={routerBase}>
              <Shell />
            </BrowserRouter>
          </QueryClientProvider>
        </WagmiProvider>
      </React.StrictMode>,
    );
  })
  .catch((error) => {
    console.error('Arc network verification failed', error);
    const panel = document.createElement('div');
    panel.className = 'boot-screen';
    panel.setAttribute('role', 'alert');
    const title = document.createElement('h1');
    title.textContent = 'Arc connection unavailable';
    const detail = document.createElement('p');
    detail.textContent = 'We couldn’t verify the Arc network. Check your connection and try again.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn primary';
    retry.textContent = 'TRY AGAIN →';
    retry.addEventListener('click', bootApplication);
    panel.append(title, detail, retry);
    rootElement.replaceChildren(panel);
  });
}
bootApplication();

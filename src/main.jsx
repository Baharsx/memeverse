import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  arcCapabilities,
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
import {
  marketAvailability,
  marketSpotLabel,
  marketSpotPerTokenLabel,
  publicMarkets,
} from './market-display';
import { publicMediaAssets } from './media-display';
import {
  filterTradeableMarkets,
  marketSoldPercent,
  mergeTradeableMarkets,
  parseMarketAddress,
  persistImportedMarketAddress,
  readImportedMarketAddresses,
  sortTradeableMarkets,
} from './imported-markets';
// Read here only to state truthfully whether this build has the Stage 2 addresses configured.
import { readMediaAssets, safeMediaUrl, stage2Contracts } from './assets';
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
  probeMemeMarket,
  quoteBuy,
  quoteSell,
  tokenSupplyValue,
  usdcAbi,
} from './market';
import { useOnchainAction } from './use-onchain-action';
import {
  AttachImageButton,
  ImagePicker,
  MarketImage,
  mediaContentUrl,
  useImageSelection,
  useMediaUpload,
} from './media-views.jsx';
import { getMarketImages } from './api';
import { MEDIA_ACTIONS } from './media-authorization';
import { canRetryLaunchArtwork, launchArtworkStage } from './media-upload';
import { BrowserRouter, NavLink, Route, Routes } from './router.jsx';
import './styles.css';

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
  // Same presentation filter as the Markets selector, so the ticker and the list can never
  // disagree about what a visitor is being shown.
  const items = publicMarkets(markets.data);
  return (
    <div className="marquee" role="group" aria-label="Live market ticker">
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
    refetchInterval: 12_000,
  });
  const balanceLabel = onArc && balance.data !== undefined
    ? `${formatUsdc(balance.data, 4)} USDC`
    : 'TESTNET';

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

  return (
    <div className="network-switch" role="group" aria-label={`${arc.name} connection status`}>
      <span className={onArc ? 'network-brand active' : 'network-brand'}>
        <i />BUILT ON ARC<sup>{onArc ? 'ON' : (ARC_IS_MAINNET ? 'MAINNET' : 'TESTNET')}</sup>
      </span>
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
  ['03', 'NFT', '/nft'],
  ['04', 'VAULT', '/vault'],
];

function Shell() {

  return (
    <>
      <a className="skip-link" href="#main-content">SKIP TO PRODUCT</a>
      <Marquee />
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
          <Route path="/nft" element={<UnderBuild n="03" title="NFT" body="Creator pieces, minted and sold in USDC, land here later. Launch and trade are already live." />} />
          <Route path="/vault" element={<UnderBuild n="04" title="VAULT" body="Deposits and redemptions land here later. Markets already settle in real USDC." />} />
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
 * The economy, in the order a visitor walks it. Each step is a real surface.
 */
const economySteps = [
  ['01', 'CREATE', '/launch', 'A meme becomes an Arc market: a token and its USDC curve, deployed from your own wallet.'],
  ['02', 'TRADE', '/markets', 'Anyone buys and sells it in USDC. The price, the reserve, and the receipt are the chain.'],
  ['03', 'OWN', '/nft', 'Creator media, minted and sold in USDC, is next. This surface is under build.'],
  ['04', 'VAULT', '/vault', 'A USDC vault for deposits and redemptions is next. This surface is under build.'],
];

function AssetCarousel({ label, detail, trackRef, count, children }) {
  function scrollCards(direction) {
    const node = trackRef.current;
    if (!node) return;
    const card = node.querySelector('.carousel-card');
    const width = card ? card.getBoundingClientRect().width + 16 : 296;
    node.scrollBy({ left: direction * width, behavior: 'smooth' });
  }

  return (
    <div className="carousel" aria-roledescription="carousel" aria-label={label}>
      <div className="carousel-head">
        <div>
          <h2>{label}</h2>
          <p>{detail}</p>
        </div>
        {count > 1 ? (
          <div className="carousel-controls">
            <button type="button" onClick={() => scrollCards(-1)} aria-label={`Previous ${label}`}>←</button>
            <button type="button" onClick={() => scrollCards(1)} aria-label={`Next ${label}`}>→</button>
          </div>
        ) : null}
      </div>
      <div className="carousel-track" ref={trackRef}>
        {children}
      </div>
    </div>
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
  const markets = useQuery({
    queryKey: ['onchain-markets', 'home'],
    queryFn: () => loadMarkets(),
    retry: 1,
    refetchInterval: 20_000,
  });
  const listed = publicMarkets(markets.data);
  const imageKey = listed.map((market) => market.address).join(',');
  const images = useQuery({
    queryKey: ['market-images', 'home', imageKey],
    queryFn: () => getMarketImages(listed.map((market) => market.address)),
    enabled: listed.length > 0,
    staleTime: 30_000,
  });
  const nftConfigured = Boolean(stage2Contracts.mediaNft);
  const collection = useQuery({
    queryKey: ['home-nfts'],
    queryFn: () => readMediaAssets({ limit: 240 }),
    enabled: nftConfigured,
    retry: 1,
    refetchInterval: 30_000,
  });
  const tokenTrack = useRef(null);
  const nftTrack = useRef(null);
  const stage2Configured = Boolean(
    stage2Contracts.mediaNft && stage2Contracts.nftMarketplace && stage2Contracts.usdcVault,
  );
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
      'NFT / VAULT',
      stage2Configured,
      stage2Configured ? 'COLLECTION / MARKETPLACE / VAULT' : 'NOT ON THIS NETWORK',
      false,
    ],
  ];
  const nftAssets = collection.data?.configured ? publicMediaAssets(collection.data.assets) : [];

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
            MemeVerse turns a meme into an Arc market. People trade it in USDC. Creator and
            treasury fees settle inside the trade.
          </p>
          <div className="hero-actions">
            <NavLink className="btn primary" to="/launch">LAUNCH A MEME →</NavLink>
            <NavLink className="btn primary" to="/markets">TRADE ONCHAIN →</NavLink>
            <NavLink className="btn secondary" to="/nft">OPEN MARKETPLACE</NavLink>
            <NavLink className="btn secondary" to="/vault">OPEN VAULT</NavLink>
          </div>
        </div>
        <aside>
          <Mascot />
          <p>
            PRODUCT: MEMEVERSE
            <br />INFRASTRUCTURE: <b className="acid">BUILT ON ARC</b>
            <br />MONEY + GAS: USDC
            <br />FEES: <b className="acid">INSIDE THE TRADE</b>
            <br />ASSETS: {ARC_IS_MAINNET ? 'REAL USDC' : 'TESTNET ONLY'}
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
        {checks.map(([label, ready, detail, pending]) => (
          <div key={label} className={ready ? 'ready' : ''}>
            <span><i />{ready ? 'VERIFIED' : pending ? 'CHECKING' : 'UNAVAILABLE'}</span>
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
          <NavLink to="/nft"><small>STEP 03 / COMING NEXT</small><strong>OWN THE MEDIA</strong><span>Under build →</span></NavLink>
          <NavLink to="/vault"><small>STEP 04 / COMING NEXT</small><strong>USDC VAULT</strong><span>Under build →</span></NavLink>
        </div>
      </section>

      <section className="home-collections" aria-label="Tokens and NFTs">
        <AssetCarousel
          label="Tokens"
          detail="Every market on this factory. One card when there is one. Scroll when there are many."
          trackRef={tokenTrack}
          count={listed.length}
        >
          {markets.isPending ? (
            <article className="carousel-card"><div><small>TOKEN</small><strong>Reading markets</strong></div></article>
          ) : null}
          {!markets.isPending && listed.length === 0 ? (
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

        <AssetCarousel
          label="NFTs"
          detail="Every piece in the collection. One card when there is one. Scroll when there are many."
          trackRef={nftTrack}
          count={nftAssets.length}
        >
          {!nftConfigured ? (
            <article className="carousel-card">
              <div className="carousel-fallback"><Mascot small /></div>
              <div>
                <small>NFT</small>
                <strong>No collection on this network</strong>
                <em>This deployment has no NFT contract</em>
              </div>
            </article>
          ) : null}
          {nftConfigured && collection.isPending ? (
            <article className="carousel-card"><div><small>NFT</small><strong>Reading the collection</strong></div></article>
          ) : null}
          {nftConfigured && collection.isSuccess && nftAssets.length === 0 ? (
            <NavLink className="carousel-card" to="/nft">
              <div className="carousel-fallback"><Mascot small /></div>
              <div><small>NFT</small><strong>No NFTs yet</strong><em>Mint the first piece</em></div>
            </NavLink>
          ) : null}
          {nftAssets.map((asset) => (
            <NavLink key={String(asset.tokenId)} className="carousel-card" to="/nft">
              <CarouselArt src={safeMediaUrl(asset.metadata?.image)} alt="" />
              <div>
                <small>NFT</small>
                <strong>{asset.metadata?.name ?? `NFT #${String(asset.tokenId)}`}</strong>
                <em>{asset.listing?.fillable ? `${asset.listing.priceUsdc} USDC` : 'IN THE COLLECTION'}</em>
              </div>
            </NavLink>
          ))}
        </AssetCarousel>
      </section>
    </>
  );
}

function CarouselArt({ src, alt }) {
  if (!src) return <div className="carousel-fallback"><Mascot small /></div>;
  return <img src={src} alt={alt} referrerPolicy="no-referrer" />;
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

function UnderBuild({ n, title, body }) {
  return (
    <section className="page under-build">
      <div className="under-build-card">
        <Mascot />
        <span className="under-build-chip"><i />UNDER BUILD</span>
        <p className="under-build-index">{n}</p>
        <h1>{title}</h1>
        <p className="lede">{body}</p>
        <div className="under-build-actions">
          <NavLink className="btn primary" to="/markets">TRADE LIVE MARKETS →</NavLink>
          <NavLink className="btn" to="/launch">LAUNCH A MEME</NavLink>
        </div>
      </div>
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
  const { address, isConnected, onArc } = useArcNetwork();
  const action = useOnchainAction();
  /*
    The image is entirely separate from the launch. It is chosen before signing purely so the
    creator can see what they are making, but it is not part of `createMarket` calldata, it is not
    part of the transaction, and it is attached — if at all — only after Arc has confirmed. A
    launch with no image is exactly as valid as one with an image.
  */
  const image = useImageSelection();
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
          <ImagePicker
            id="launch-market-image"
            label="MARKET IMAGE (OPTIONAL)"
            hint="PNG, JPEG, or WebP, up to 5 MB. Attached after the launch confirms — it is not part of the transaction and costs no gas."
            selection={image.selection}
            error={image.error}
            onSelect={image.select}
            onClear={image.clear}
          />
          <div className="receive">
            <span>FIXED ONCHAIN SUPPLY</span>
            <b>{Number(supply || 0).toLocaleString()} ${symbol || 'TOKEN'}</b>
          </div>
          <button className="btn primary full" disabled={action.state.status === 'WALLET_SIGNATURE' || action.state.status === 'SUBMITTED'}>REVIEW ONCHAIN LAUNCH →</button>
          {formError ? <small className="tx-error" role="alert">{formError}</small> : null}
          {review ? <div className="onchain-review" role="region" aria-label="Launch review"><b>REVIEW BEFORE SIGNING</b><span>CREATOR // {address ?? 'CONNECT WALLET'}</span><span>FACTORY // {arcContracts.memeVerseFactory}</span><span>PRICE // {basePrice} + UP TO {slopePrice} USDC</span><span>FEES // {factory.data ? `${Number(factory.data.creatorFeeBps) / 100}% CREATOR + ${Number(factory.data.treasuryFeeBps) / 100}% TREASURY` : 'READING ONCHAIN'}</span><button className="btn primary full" type="button" disabled={!onArc || !factory.data || ['WALLET_SIGNATURE', 'SUBMITTED'].includes(action.state.status)} onClick={launchMarket}>{!isConnected ? 'CONNECT WALLET FIRST' : !onArc ? (ARC_IS_MAINNET ? 'SWITCH TO ARC MAINNET' : 'SWITCH TO ARC TESTNET') : 'SIGN + LAUNCH ON ARC →'}</button></div> : null}
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
                    ? `${attach.state.error ?? 'The image could not be attached.'} Retry below, or set the image any time from Markets.`
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
        <aside className="spec">
          <span>DEPLOYMENT SPEC</span>
          <dl>
            <dt>MODE</dt><dd>ONCHAIN</dd>
            <dt>NETWORK</dt><dd>{network.chain.name}</dd>
            <dt>SETTLEMENT</dt><dd>USDC</dd>
            <dt>CURVE</dt><dd>LINEAR / WHOLE TOKEN</dd>
            <dt>BROADCAST</dt><dd>WALLET SIGNED</dd>
            <dt>IMAGE</dt><dd>{image.selection ? 'SELECTED / OFFCHAIN' : 'NONE'}</dd>
          </dl>
          {/* The chosen artwork stands in for the mark, so the spec previews the market as it
              will look. Falling back to the mark when nothing is chosen keeps this panel
              identical to what it has always been for an image-less launch. */}
          {image.selection
            ? (
              <figure className="spec-artwork">
                <img src={image.selection.previewUrl} alt="Selected market artwork preview" />
                <figcaption>OFFCHAIN PRESENTATION IMAGE</figcaption>
              </figure>
            )
            : <Mascot />}
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

/**
 * Creator-only artwork management for an existing market.
 *
 * Secondary by design: it sits below the order form, it is collapsed until asked for, and it
 * never competes with the live financial data above it. Only the market's creator sees it — but
 * that is presentation. The server reads `creator()` from the market contract on Arc and refuses
 * anyone else, so hiding this control is convenience and the real boundary is elsewhere.
 */
function MarketImageManager({ market, hasImage, onChanged }) {
  const { address } = useAccount();
  const [open, setOpen] = useState(false);
  const image = useImageSelection();
  const attach = useMediaUpload({
    action: MEDIA_ACTIONS.MARKET_AVATAR,
    market: market.address,
    selection: image.selection,
    onUploaded: async () => {
      image.clear();
      await onChanged();
    },
  });

  const isCreator = address && market.creator
    && address.toLowerCase() === market.creator.toLowerCase();
  if (!isCreator) return null;

  return (
    <section className="market-image-manager">
      <button
        type="button"
        className="btn ghost full"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {hasImage ? 'REPLACE MARKET IMAGE' : 'SET MARKET IMAGE'} {open ? '▲' : '▼'}
      </button>
      {open ? (
        <div className="market-image-manager-body">
          <p>
            Market artwork is authenticated offchain presentation metadata keyed to this market’s
            address. Attaching it is a free wallet signature that proves you are the market’s
            onchain <code>creator()</code>. It costs no gas and moves no funds.
          </p>
          <ImagePicker
            id={`market-image-${market.address}`}
            label="NEW MARKET IMAGE"
            selection={image.selection}
            error={image.error}
            onSelect={image.select}
            onClear={image.clear}
          />
          {image.selection ? (
            <AttachImageButton state={attach.state} onStart={attach.start}>
              SIGN + {hasImage ? 'REPLACE' : 'SET'} MARKET IMAGE →
            </AttachImageButton>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Markets() {
  const { address, isConnected, onArc } = useArcNetwork();
  const [selectedAddress, setSelectedAddress] = useState(null);
  const [tradeOpen, setTradeOpen] = useState(false);
  const tradeDialogRef = useRef(null);
  const [side, setSide] = useState('BUY');
  const [buyAmount, setBuyAmount] = useState('0.01');
  const [sellAmount, setSellAmount] = useState('1');
  const [boardQuery, setBoardQuery] = useState('');
  const [boardSort, setBoardSort] = useState('newest');
  const [onlyHeld, setOnlyHeld] = useState(false);
  const [importValue, setImportValue] = useState('');
  const [importState, setImportState] = useState({ status: 'IDLE', message: null });
  const [importedAddresses, setImportedAddresses] = useState(() => readImportedMarketAddresses());
  const slippageBps = 100;
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
  /*
    What this page browses: every registered market except the project's own legacy test markets.
    The full factory result stays in `markets.data` and is untouched — this is the presentation
    view of it. Imported onchain markets are merged on afterwards and never rewrite the factory set.
  */
  const visibleMarkets = useMemo(() => publicMarkets(markets.data), [markets.data]);
  const importedMarkets = useQuery({
    queryKey: ['imported-onchain-markets', importedAddresses.join(','), address ?? 'anonymous'],
    queryFn: async () => {
      const loaded = [];
      for (const imported of importedAddresses) {
        const probed = await probeMemeMarket(imported, address);
        if (probed.ok) loaded.push(probed.market);
      }
      return loaded;
    },
    enabled: importedAddresses.length > 0,
    retry: 1,
    staleTime: 12_000,
  });
  const boardMarkets = useMemo(() => {
    const merged = mergeTradeableMarkets(visibleMarkets, importedMarkets.data);
    const filtered = filterTradeableMarkets(merged, { query: boardQuery, onlyHeld });
    return sortTradeableMarkets(filtered, boardSort);
  }, [visibleMarkets, importedMarkets.data, boardQuery, boardSort, onlyHeld]);
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
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    tradeDialogRef.current?.focus();
    function onKey(event) {
      if (event.key === 'Escape') setTradeOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [tradeOpen]);

  let buyUnits = 0n;
  let sellUnits = 0n;
  let buyInputError = null;
  let sellInputError = null;
  try { buyUnits = parseUsdc(buyAmount); } catch (error) { buyInputError = error.message; }
  try { sellUnits = parseWholeTokens(sellAmount); } catch (error) { sellInputError = error.message; }

  const buyQuote = useQuery({
    queryKey: ['market-buy-quote', selected?.address, buyUnits.toString()],
    queryFn: () => quoteBuy(selected.address, buyUnits),
    enabled: Boolean(tradeOpen && selected && buyUnits > 0n),
    retry: 1,
    refetchInterval: 8_000,
  });
  const sellQuote = useQuery({
    queryKey: ['market-sell-quote', selected?.address, sellUnits.toString()],
    queryFn: () => quoteSell(selected.address, sellUnits),
    enabled: Boolean(tradeOpen && selected && sellUnits > 0n),
    retry: 1,
    refetchInterval: 8_000,
  });
  const approval = useOnchainAction();
  const buy = useOnchainAction();
  const sell = useOnchainAction();
  const allowanceRequired = Boolean(selected && buyUnits > selected.usdcAllowance);
  const availability = marketAvailability(selected);

  function openTrade(address, nextSide) {
    setSelectedAddress(address);
    setSide(nextSide);
    setTradeOpen(true);
  }

  async function refreshMarketState() {
    await Promise.all([
      markets.refetch(),
      importedMarkets.refetch(),
      usdcBalance.refetch(),
      queryClient.invalidateQueries({ queryKey: ['market-buy-quote'] }),
      queryClient.invalidateQueries({ queryKey: ['market-sell-quote'] }),
    ]);
  }

  async function importOnchainMarket(event) {
    event.preventDefault();
    const parsed = parseMarketAddress(importValue);
    if (!parsed) {
      setImportState({ status: 'ERROR', message: 'Paste a 20-byte Arc contract address.' });
      return;
    }
    setImportState({ status: 'LOADING', message: 'Reading the contract on Arc…' });
    try {
      const probed = await probeMemeMarket(parsed, address);
      if (!probed.ok) {
        const copy = {
          INVALID_ADDRESS: 'Paste a 20-byte Arc contract address.',
          BANNED_CONTRACT: 'That address is a banned legacy contract and cannot be imported.',
          NOT_MEME_MARKET: 'That contract is not a MemeVerse USDC market. Buy and sell only work on MemeMarket contracts.',
          NOT_USDC_MARKET: 'That market does not settle in Arc USDC, so it cannot be traded here.',
        }[probed.code] ?? 'That contract could not be loaded as a tradable market.';
        setImportState({ status: 'ERROR', message: copy });
        return;
      }
      setImportedAddresses(persistImportedMarketAddress(probed.market.address));
      openTrade(probed.market.address, 'BUY');
      setImportValue('');
      setImportState({
        status: 'OK',
        message: probed.market.origin === 'FACTORY'
          ? `${probed.market.symbol} is already a live factory market.`
          : `${probed.market.symbol} imported from Arc. You can buy and sell it against the USDC curve.`,
      });
    } catch (error) {
      setImportState({ status: 'ERROR', message: error.shortMessage ?? error.message ?? 'Import failed.' });
    }
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
      <p className="lede">
        Trade any MemeVerse market that lives on Arc — launched here or pasted from a contract
        address. Quotes, reserves, positions, and fees are live chain state. Every buy and sell
        pays the creator and the treasury in the same transaction.
      </p>
      <form className="market-toolbar" onSubmit={importOnchainMarket}>
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
        <button
          type="button"
          className={`btn ghost filter-held ${onlyHeld ? 'active' : ''}`}
          aria-pressed={onlyHeld}
          onClick={() => setOnlyHeld((current) => !current)}
        >
          {onlyHeld ? 'SHOWING YOUR BAGS' : 'YOUR POSITIONS'}
        </button>
        <label className="market-import">
          IMPORT ANY ONCHAIN MARKET
          <span>
            <input
              value={importValue}
              onChange={(event) => setImportValue(event.target.value)}
              placeholder="0x… market address on Arc"
              spellCheck="false"
            />
            <button className="btn primary" disabled={importState.status === 'LOADING'}>
              {importState.status === 'LOADING' ? 'READING ARC…' : 'TRADE IT →'}
            </button>
          </span>
        </label>
      </form>
      {importState.message ? (
        <p className={importState.status === 'ERROR' ? 'agent-error' : 'import-ok'} role="status">
          {importState.message}
        </p>
      ) : null}
      {markets.isError ? <p className="agent-error" role="alert">ARC RPC READ FAILED // {markets.error.shortMessage ?? 'Public RPC unavailable. Retry shortly.'}</p> : null}
      {!markets.isPending && !boardMarkets.length ? (
        <div className="empty"><Mascot small /><span>NO MARKETS MATCH THIS VIEW<br /><NavLink to="/launch">LAUNCH A MARKET →</NavLink></span></div>
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
                    <span className={`origin-chip ${market.origin === 'IMPORTED' ? 'imported' : ''}`}>
                      {market.origin === 'IMPORTED' ? 'IMPORTED' : 'FACTORY'}
                    </span>
                  </div>
                  <div className="market-card-body">
                    <small>{market.symbol}</small>
                    <strong>{market.name}</strong>
                    <b>{marketSpotPerTokenLabel(market, formatUsdc)}</b>
                    <span className="sold-meter" aria-hidden="true"><i style={{ width: `${sold}%` }} /></span>
                    <em>{market.soldTokenCount.toLocaleString()} / {market.totalSupplyTokens.toLocaleString()} sold · {formatUsdc(market.reserveUsdc)} USDC reserve</em>
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
      {tradeOpen && selected ? (
        <div className="trade-modal" onMouseDown={(event) => { if (event.target === event.currentTarget) setTradeOpen(false); }}>
          <div
            className="trade-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trade-modal-title"
            tabIndex={-1}
            ref={tradeDialogRef}
          >
            <button type="button" className="trade-modal-close" onClick={() => setTradeOpen(false)}>CLOSE</button>
            <div className="market-terminal">
              <section className="market-proof">
                <div className="market-identity">
                  <MarketImage src={imageFor(selected)} alt={`${selected.symbol} artwork`} size="md" />
                  <div>
                    <small>MARKET</small>
                    <strong id="trade-modal-title">{selected.name} / ${selected.symbol}</strong>
                    <ExternalLink href={`${arcLinks.explorer}/address/${selected.address}`}>{shortAddress(selected.address)} ↗</ExternalLink>
                  </div>
                </div>
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
                <MarketImageManager
                  market={selected}
                  hasImage={Boolean(marketImages.data?.[selected.address])}
                  onChanged={() => marketImages.refetch()}
                />
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

const rootElement = document.getElementById('root');
assertBrowserReadChain()
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
    const message = error instanceof Error
      ? error.message
      : 'Arc mainnet chain check failed. Refusing to boot.';
    rootElement.replaceChildren(document.createTextNode(message));
  });

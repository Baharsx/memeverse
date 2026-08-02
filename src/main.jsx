import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

const network = {
  chain: arc,
  label: 'ARC TESTNET',
  money: 'USDC',
  gas: 'USDC',
  settlement: '1 BLOCK',
  accent: 'STABLECOIN-NATIVE',
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
    <button className="wallet" onClick={() => disconnect()}>
      <i />TESTNET {address.slice(0, 6)}…{address.slice(-4)}
    </button>
  ) : (
    <button className="wallet" onClick={() => connect({ connector: injected() })}>
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

function Shell() {
  const navItems = [
    ['01', 'LAUNCH', '/launch'],
    ['02', 'TRADE', '/trade'],
    ['03', 'NFT', '/nft'],
    ['04', 'VAULT', '/vault'],
    ['05', 'AGENT', '/agent'],
    ['06', 'SAFETY', '/safety'],
  ];

  return (
    <>
      <Marquee />
      <div className="network-bar">
        <span>PUBLIC TESTNET // NO REAL ASSETS</span>
        <NetworkStatus />
        <ExternalLink href={arcLinks.status}>NETWORK STATUS ↗</ExternalLink>
      </div>
      <div className="testnet-banner">
        SIMULATION ENVIRONMENT — VERIFY CHAIN {arc.id} BEFORE SIGNING — NEVER SHARE
        KEYS OR SEED PHRASES
      </div>
      <header>
        <NavLink className="brand" to="/">
          <img
            className="brand-lockup"
            src={`${import.meta.env.BASE_URL}memeverse-lockup.png`}
            alt="MemeVerse"
          />
        </NavLink>
        <nav>
          {navItems.map((item) => (
            <NavLink key={item[1]} to={item[2]}>
              <sup>{item[0]}</sup>
              {item[1]}
            </NavLink>
          ))}
        </nav>
        <Wallet />
      </header>
      <main>
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

function Stat({ n, l }) {
  return (
    <div>
      <strong>{n}</strong>
      <small>{l}</small>
    </div>
  );
}

function Home() {
  return (
    <>
      <section className="hero">
        <div>
          <div className="eyebrow">
            {arcCapabilities.phase} / CHAIN {network.chain.id}
          </div>
          <h1>
            MEMES ARE
            <br />
            <mark>FINANCIAL</mark>
            <br />PRIMITIVES.
          </h1>
          <p>
            Prototype culture markets with USDC as the money, gas and settlement
            layer. Every current action is a transparent Testnet simulation until
            the corresponding contracts are deployed and verified.
          </p>
          <NavLink className="btn primary" to="/launch">
            BUILD ON {network.label} →
          </NavLink>
        </div>
        <aside>
          <Mascot />
          <p>
            SETTLEMENT_LAYER: ARC
            <br />STATUS: <b className="acid">PUBLIC TESTNET</b>
            <br />ASSET_VALUE: TEST ONLY
          </p>
        </aside>
      </section>
      <section className="stats">
        <Stat n="USDC" l="NATIVE GAS" />
        <Stat n={network.chain.id} l="CHAIN ID" />
        <Stat n={network.settlement} l="FINALITY MODEL" />
        <Stat n="TESTNET" l="NO REAL ASSETS" />
      </section>
      <section className="split">
        <div>
          <Title n="05" t="SIMULATED MARKETS" />
          <div className="coin-table">
            {coins.map((coin, index) => (
              <div className="coin-row" key={coin[0]}>
                <span className="rank">0{index + 1}</span>
                <span>
                  <b>{coin[0]}</b>
                  <small>${coin[1]} / DEMO</small>
                </span>
                <strong>{coin[2]}</strong>
                <em className={coin[3][0] === '-' ? 'down' : 'up'}>
                  {coin[3][0] === '-' ? '▼' : '▲'} {coin[3]}%
                </em>
                <button>PREVIEW</button>
              </div>
            ))}
          </div>
        </div>
        <div>
          <Title n="06" t="DEMO DROPS" />
          {nfts.slice(0, 2).map((item, index) => (
            <NFTCard key={item[0]} n={item[0]} p={item[1]} i={index} />
          ))}
        </div>
      </section>
    </>
  );
}

function Title({ n, t }) {
  return (
    <div className="title">
      <span>{n}</span>
      <h2>{t}</h2>
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
      <Title n="01" t="LAUNCH A MEME" />
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

function Chart() {
  return (
    <svg className="chart" viewBox="0 0 800 360" preserveAspectRatio="none" aria-label="Simulated price chart">
      <g className="grid">
        {[60, 120, 180, 240, 300].map((y) => (
          <line key={y} x1="0" y1={y} x2="800" y2={y} />
        ))}
      </g>
      <polyline points="0,290 70,278 130,240 190,260 250,192 310,210 370,130 430,151 490,100 550,120 610,63 670,91 735,41 800,54" />
    </svg>
  );
}

function Trade() {
  const [side, setSide] = useState('BUY');
  const [amount, setAmount] = useState('25');

  return (
    <section className="page">
      <Title n="02" t="TRADE / PEPX / DEMO" />
      <div className="trade-grid">
        <div className="chartbox">
          <div className="quote">
            <span>PEPE.exe / SIMULATED USD</span>
            <b>$0.004218</b>
            <em className="up">▲ 18.4%</em>
          </div>
          <Chart />
          <div className="axis">00:00　04:00　08:00　12:00　16:00　20:00　NOW</div>
        </div>
        <div className="order">
          <div className="tabs">
            <button className={side === 'BUY' ? 'active' : ''} onClick={() => setSide('BUY')}>BUY</button>
            <button className={side === 'SELL' ? 'sell' : ''} onClick={() => setSide('SELL')}>SELL</button>
          </div>
          <label>
            YOU PAY
            <input value={amount} onChange={(event) => setAmount(event.target.value)} />
            <small>{network.money}</small>
          </label>
          <div className="receive">
            <span>SIMULATED RECEIVE</span>
            <b>{(Number(amount || 0) * 237).toFixed(0)} PEPX</b>
          </div>
          <dl>
            <dt>CURVE PROGRESS</dt><dd>68.4% DEMO</dd>
            <dt>PRICE IMPACT</dt><dd>0.82% DEMO</dd>
            <dt>BROADCAST</dt><dd>DISABLED</dd>
          </dl>
          <button className="btn primary full">PREVIEW {side} →</button>
        </div>
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
        <button>PREVIEW</button>
      </div>
    </article>
  );
}

function NFT() {
  const [modal, setModal] = useState(false);
  const items = [
    ...nfts,
    ['LIQUIDITY GOBLIN #2', '160 USDC'],
    ['EXIT SIGNAL #69', '110 USDC'],
    ['DEGEN RELIC #404', '320 USDC'],
  ];

  return (
    <section className="page">
      <Title n="03" t="NFT ARCHIVE / DEMO" />
      <div className="nft-grid">
        {items.map((item, index) => (
          <button className="nft-trigger" key={item[0]} onClick={() => setModal(true)}>
            <NFTCard n={item[0]} p={item[1]} i={index % 3} />
          </button>
        ))}
      </div>
      {modal ? (
        <div className="modal" onClick={() => setModal(false)}>
          <div role="dialog" aria-modal="true" aria-label="Preview NFT listing" onClick={(event) => event.stopPropagation()}>
            <button className="x" onClick={() => setModal(false)} aria-label="Close">×</button>
            <Title n="DEMO" t="PREVIEW ASK PRICE" />
            <label>
              PRICE
              <input placeholder="0.00" />
              <small>USDC</small>
            </label>
            <button className="btn primary full">PREVIEW LISTING →</button>
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
      <Title n="04" t="SIMULATED ASSETS" />
      <div className="big-tabs">
        <button className={tab === 'TOKENS' ? 'active' : ''} onClick={() => setTab('TOKENS')}>TOKENS / 03</button>
        <button className={tab === 'NFTS' ? 'active' : ''} onClick={() => setTab('NFTS')}>NFTS / 02</button>
      </div>
      {tab === 'TOKENS' ? (
        <div className="assets">
          {coins.slice(0, 3).map((coin, index) => (
            <div key={coin[0]}>
              <b>{coin[0]} <small>${coin[1]}</small></b>
              <strong>{[238400, 91420, 404808][index].toLocaleString()}</strong>
              <span>{coin[2]} DEMO</span>
              <button>PREVIEW ↗</button>
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
  const trace = [
    ['01', 'INGEST SIGNAL', 'PEPX / SCORE 84'],
    ['02', 'CHECK POLICY', 'PASS / CAP OK'],
    ['03', 'PREPARE ALLOCATION', '25.00 USDC'],
    ['04', 'ATTACH REFERENCE', 'MEMO ID READY'],
    ['05', 'REQUEST SIGNATURE', 'NOT BROADCAST'],
  ];

  function runSimulation() {
    const reference = createReferenceId('AGENT-PAYOUT');
    setRecord(createSimulationRecord('AGENT_PAYOUT', reference));
  }

  return (
    <section className="page agent-page">
      <Title n="05" t="AUTONOMOUS SETTLEMENT" />
      <p className="lede">
        An onchain curator agent scores meme traction, allocates a capped treasury,
        and prepares creator settlement in {network.money}. This page models policy
        and reconciliation only; it never signs or broadcasts a transaction.
      </p>
      <div className="agent-grid">
        <div className="agent-rules">
          <span>DECISION POLICY / V1.1</span>
          <label>MAX SPEND / RUN<input defaultValue="25.00" /><small>{network.money}</small></label>
          <label>MIN. VIRALITY SCORE<input defaultValue="78" /><small>/100</small></label>
          <label>CREATOR SETTLEMENT<input defaultValue="60" /><small>%</small></label>
          <dl>
            <dt>SIGNAL</dt><dd>VOLUME + HOLDERS</dd>
            <dt>RISK LIMIT</dt><dd>2.5% TREASURY</dd>
            <dt>EXECUTION</dt><dd>NON-CUSTODIAL</dd>
            <dt>NETWORK</dt><dd>{network.chain.name}</dd>
            <dt>RETRY POLICY</dt><dd>NO BLIND RETRIES</dd>
          </dl>
          <button className="btn primary full" onClick={runSimulation}>RUN AGENT SIMULATION →</button>
        </div>
        <div className="agent-log">
          <span>EXECUTION TRACE</span>
          {trace.map((item) => (
            <div className={record ? 'done' : ''} key={item[0]}>
              <b>{item[0]}</b>
              <span>{item[1]}</span>
              <strong>{record ? item[2] : 'PENDING'}</strong>
            </div>
          ))}
          <div className="agent-status">
            {record ? `SIMULATION COMPLETE // ${record.reference}` : 'AWAITING SIGNAL // SIMULATION MODE'}
          </div>
        </div>
      </div>
      {record ? <SimulationReceipt record={record} /> : null}
      <div className="stack-strip">
        <span>BUILT ON ARC</span>
        <span>USDC GAS</span>
        <span>MEMO READY</span>
        <span>EXPLICIT TX STATES</span>
        <span>NO BLIND RETRIES</span>
        <span>CONDITIONAL SETTLEMENT</span>
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
      <Title n="06" t="SAFETY / OFFICIAL SOURCES" />
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

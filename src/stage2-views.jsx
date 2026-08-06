import React, { useMemo, useState } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { keccak256, maxUint256, stringToHex } from 'viem';
import { arc, arcContracts, arcLinks } from './arc';
import { usdcAbi } from './market';
import {
  formatUsdcAmount,
  mediaNftAbi,
  nftMarketplaceAbi,
  parseUsdcAmount,
  readCreatableMarkets,
  readMediaAssets,
  readMarketplaceAllowance,
  readVaultPosition,
  stage2Contracts,
  vaultAbi,
} from './assets';
import { useOnchainAction } from './use-onchain-action';
import { getAgentAutonomy } from './api';

/**
 * The Stage 2 product surfaces: real Arc media NFTs, a real USDC marketplace, a real USDC vault,
 * and the autonomous agent's evidence trail.
 *
 * Every value rendered here comes from a deployed contract or the backend's sanitized status
 * endpoint. Where something is unavailable — no wallet, wrong network, unconfigured contract,
 * empty collection — the surface says so explicitly rather than filling the gap with a
 * placeholder. Nothing is ever shown as complete before its Arc receipt confirms.
 */

const explorer = arc.blockExplorers.default.url;

function shorten(value, lead = 6, tail = 4) {
  if (typeof value !== 'string' || value.length <= lead + tail + 2) return value ?? '—';
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function ArcScanLink({ kind = 'address', value, children, className = '' }) {
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

/** Renders the real lifecycle of a wallet transaction. Never optimistic. */
function TxStatus({ state, label }) {
  if (state.status === 'IDLE') return null;
  const copy = {
    REQUESTED: 'PREPARING…',
    WALLET_SIGNATURE: 'WAITING FOR WALLET…',
    SUBMITTED: 'PENDING ON ARC…',
    CONFIRMED: 'CONFIRMED',
    FAILED: 'FAILED',
  }[state.status] ?? state.status;
  return (
    <div className={`receipt tx-status tx-${state.status.toLowerCase()}`} role="status" aria-live="polite">
      <b>{label}: {copy}</b>
      {state.hash ? <span>TX <ArcScanLink kind="tx" value={state.hash} /></span> : null}
      {state.error ? <span className="tx-error">{state.error}</span> : null}
    </div>
  );
}

/** One consistent explanation for every reason a surface cannot act. */
function Unavailable({ title, detail, children }) {
  return (
    <div className="empty stage2-unavailable">
      <span>
        <b>{title}</b>
        {detail ? <><br />{detail}</> : null}
      </span>
      {children}
    </div>
  );
}

function useWalletContext() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  return {
    address,
    isConnected,
    wrongNetwork: isConnected && chainId !== arc.id,
    chainId,
  };
}

/** Shared preconditions: wallet, network, and contract configuration. */
function guard({ isConnected, wrongNetwork }, contract, contractName) {
  if (!contract) {
    return (
      <Unavailable
        title={`${contractName} NOT CONFIGURED`}
        detail="This deployment has no address configured for this contract. Nothing is simulated in its place."
      />
    );
  }
  if (!isConnected) {
    return <Unavailable title="WALLET DISCONNECTED" detail="Connect an Arc Testnet wallet to continue." />;
  }
  if (wrongNetwork) {
    return <Unavailable title="WRONG NETWORK" detail={`Switch to Arc Public Testnet (chain ${arc.id}).`} />;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Media NFT + USDC marketplace
// ─────────────────────────────────────────────────────────────────────────────

function MediaCard({ asset, wallet, onChanged }) {
  const [price, setPrice] = useState('');
  const list = useOnchainAction();
  const cancel = useOnchainAction();
  const buy = useOnchainAction();
  const approveNft = useOnchainAction();
  const approveUsdc = useOnchainAction();

  const isOwner = wallet.address
    && asset.owner.toLowerCase() === wallet.address.toLowerCase();
  const listing = asset.listing;
  const image = asset.metadata?.image ?? null;

  const allowance = useQuery({
    queryKey: ['marketplace-allowance', wallet.address],
    queryFn: () => readMarketplaceAllowance(wallet.address),
    enabled: Boolean(wallet.address) && Boolean(listing),
    staleTime: 10_000,
  });

  async function run(action, request) {
    await action.execute(request);
    await onChanged();
  }

  return (
    <article className="nft-card media-card">
      <div className="art media-art">
        {image
          ? <img src={image} alt={asset.metadata?.name ?? `MemeVerse media #${asset.tokenId}`} loading="lazy" />
          : <span className="media-missing">NO MEDIA URI</span>}
      </div>
      <div className="media-body">
        <small>TOKEN #{String(asset.tokenId)}</small>
        <h3>{asset.metadata?.name ?? `MEMEVERSE MEDIA #${String(asset.tokenId)}`}</h3>

        <dl className="media-facts">
          <div><dt>CREATOR</dt><dd><ArcScanLink value={asset.creator} /></dd></div>
          <div><dt>MARKET</dt><dd><ArcScanLink value={asset.market} /></dd></div>
          <div><dt>OWNER</dt><dd><ArcScanLink value={asset.owner} /></dd></div>
          <div><dt>MINTED</dt><dd>BLOCK {asset.mintedAtBlock}</dd></div>
          <div className="media-hash">
            <dt>CONTENT HASH</dt>
            <dd title={asset.contentHash}>{shorten(asset.contentHash, 10, 8)}</dd>
          </div>
        </dl>

        {listing ? (
          <div className={`media-listing ${listing.fillable ? '' : 'stale'}`}>
            <b>{listing.fillable ? 'LISTED' : 'LISTING STALE'}</b>
            <span>{listing.priceUsdc} USDC</span>
            {!listing.fillable
              ? <small>Seller no longer owns this token or revoked approval. It cannot be bought.</small>
              : null}
          </div>
        ) : <div className="media-listing"><b>NOT LISTED</b></div>}

        {/* Owner actions */}
        {isOwner && !listing ? (
          <div className="media-actions">
            <label>
              ASK PRICE
              <input
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                aria-label="Listing price in USDC"
              />
              <small>USDC</small>
            </label>
            <button
              type="button"
              className="btn"
              disabled={approveNft.state.status === 'SUBMITTED'}
              onClick={() => run(approveNft, {
                address: stage2Contracts.mediaNft,
                abi: mediaNftAbi,
                functionName: 'approve',
                args: [stage2Contracts.nftMarketplace, asset.tokenId],
              })}
            >
              1. APPROVE MARKETPLACE
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!price || Number(price) <= 0}
              onClick={() => run(list, {
                address: stage2Contracts.nftMarketplace,
                abi: nftMarketplaceAbi,
                functionName: 'list',
                args: [asset.tokenId, parseUsdcAmount(price)],
              })}
            >
              2. LIST FOR USDC →
            </button>
            <TxStatus state={approveNft.state} label="APPROVE" />
            <TxStatus state={list.state} label="LIST" />
          </div>
        ) : null}

        {isOwner && listing ? (
          <div className="media-actions">
            <button
              type="button"
              className="btn"
              onClick={() => run(cancel, {
                address: stage2Contracts.nftMarketplace,
                abi: nftMarketplaceAbi,
                functionName: 'cancel',
                args: [asset.tokenId],
              })}
            >
              CANCEL LISTING
            </button>
            <TxStatus state={cancel.state} label="CANCEL" />
          </div>
        ) : null}

        {/* Buyer actions */}
        {!isOwner && listing?.fillable && wallet.isConnected ? (
          <div className="media-actions">
            {(allowance.data ?? 0n) < listing.priceUnits ? (
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  await approveUsdc.execute({
                    address: arcContracts.usdc,
                    abi: usdcAbi,
                    functionName: 'approve',
                    args: [stage2Contracts.nftMarketplace, listing.priceUnits],
                  });
                  await allowance.refetch();
                }}
              >
                1. APPROVE {listing.priceUsdc} USDC
              </button>
            ) : null}
            <button
              type="button"
              className="btn primary"
              disabled={(allowance.data ?? 0n) < listing.priceUnits}
              onClick={() => run(buy, {
                address: stage2Contracts.nftMarketplace,
                abi: nftMarketplaceAbi,
                functionName: 'buy',
                args: [asset.tokenId],
              })}
            >
              BUY FOR {listing.priceUsdc} USDC →
            </button>
            <TxStatus state={approveUsdc.state} label="APPROVE USDC" />
            <TxStatus state={buy.state} label="BUY" />
          </div>
        ) : null}
      </div>
    </article>
  );
}

function MintMedia({ wallet, onMinted }) {
  const [form, setForm] = useState({ market: '', mediaUrl: '', contentHash: '', name: '' });
  const mint = useOnchainAction();

  const markets = useQuery({
    queryKey: ['creatable-markets', wallet.address],
    queryFn: () => readCreatableMarkets(wallet.address),
    enabled: Boolean(wallet.address) && !wallet.wrongNetwork,
    staleTime: 30_000,
  });

  const validHash = /^0x[a-fA-F0-9]{64}$/.test(form.contentHash);
  const canMint = form.market && validHash && form.mediaUrl.trim();

  const metadataUri = useMemo(() => {
    if (!canMint) return null;
    const metadata = {
      name: form.name.trim() || 'MemeVerse Media',
      description: 'MemeVerse media asset bound onchain to a registered MemeVerse market.',
      image: form.mediaUrl.trim(),
      attributes: [
        { trait_type: 'market', value: form.market },
        { trait_type: 'creator', value: wallet.address },
        { trait_type: 'contentHash', value: form.contentHash },
        { trait_type: 'contentHashScheme', value: 'keccak256(file bytes)' },
      ],
    };
    // Self-contained metadata: no host is required for it to stay resolvable or verifiable.
    return `data:application/json;base64,${btoa(JSON.stringify(metadata))}`;
  }, [canMint, form, wallet.address]);

  async function hashFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    setForm((current) => ({ ...current, contentHash: keccak256(bytes) }));
  }

  if (markets.isLoading) return <div className="empty"><span>CHECKING YOUR MARKETS…</span></div>;

  if ((markets.data ?? []).length === 0) {
    return (
      <Unavailable
        title="NO MARKET TO MINT AGAINST"
        detail="Media provenance is enforced onchain: only the creator of a market registered in the trusted MemeVerse factory can mint media for it. Launch a market first."
      />
    );
  }

  return (
    <div className="mint-panel">
      <h3>MINT MEDIA ASSET</h3>
      <p className="mint-note">
        The contract verifies that the market is registered in the trusted factory and that you
        are its <code>creator()</code>. Provenance cannot be forged from the browser.
      </p>
      <label>
        MARKET
        <select
          value={form.market}
          onChange={(event) => setForm({ ...form, market: event.target.value })}
        >
          <option value="">SELECT A MARKET YOU CREATED</option>
          {(markets.data ?? []).map((market) => (
            <option key={market.address} value={market.address}>
              {market.symbol} — {shorten(market.address)}
            </option>
          ))}
        </select>
      </label>
      <label>
        MEDIA URL
        <input
          value={form.mediaUrl}
          onChange={(event) => setForm({ ...form, mediaUrl: event.target.value })}
          placeholder="https://…"
        />
      </label>
      <label>
        MEDIA FILE (COMPUTES THE REAL DIGEST)
        <input
          type="file"
          onChange={(event) => event.target.files?.[0] && hashFile(event.target.files[0])}
        />
        <small>keccak256 of the exact file bytes</small>
      </label>
      <label>
        CONTENT HASH
        <input
          value={form.contentHash}
          onChange={(event) => setForm({ ...form, contentHash: event.target.value })}
          placeholder="0x… (64 hex)"
        />
        {form.contentHash && !validHash ? <small className="tx-error">Not a 32-byte hash.</small> : null}
      </label>
      <label>
        NAME
        <input
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="MemeVerse Media"
        />
      </label>
      <button
        type="button"
        className="btn primary full"
        disabled={!canMint}
        onClick={async () => {
          await mint.execute({
            address: stage2Contracts.mediaNft,
            abi: mediaNftAbi,
            functionName: 'mint',
            args: [form.market, form.contentHash, metadataUri],
          });
          await onMinted();
        }}
      >
        MINT ON ARC →
      </button>
      <TxStatus state={mint.state} label="MINT" />
    </div>
  );
}

export function MediaAssets() {
  const wallet = useWalletContext();
  const assets = useQuery({
    queryKey: ['media-assets'],
    queryFn: () => readMediaAssets(),
    enabled: Boolean(stage2Contracts.mediaNft),
    retry: 1,
    refetchInterval: 30_000,
  });

  const blocked = guard(wallet, stage2Contracts.mediaNft, 'MEDIA NFT');

  return (
    <section className="page">
      <div className="stage2-header">
        <h1><sup>LAB A</sup> MEDIA ASSETS</h1>
        <div className="stage2-meta">
          <span>NFT <ArcScanLink value={stage2Contracts.mediaNft} /></span>
          <span>MARKETPLACE <ArcScanLink value={stage2Contracts.nftMarketplace} /></span>
          <span>SETTLED IN ARC USDC — NO MARKETPLACE FEE</span>
        </div>
      </div>

      {!stage2Contracts.mediaNft ? (
        <Unavailable
          title="MEDIA NFT NOT CONFIGURED"
          detail="No collection address is configured for this deployment."
        />
      ) : null}

      {stage2Contracts.mediaNft && assets.isLoading
        ? <div className="empty"><span>READING ARC…</span></div> : null}

      {stage2Contracts.mediaNft && assets.isError ? (
        <Unavailable
          title="ARC RPC UNAVAILABLE"
          detail="The collection could not be read. No cached or placeholder data is shown."
        />
      ) : null}

      {assets.data?.configured && assets.data.assets.length === 0 ? (
        <Unavailable title="NO MEDIA MINTED YET" detail="This collection is empty on Arc." />
      ) : null}

      {assets.data?.assets?.length ? (
        <div className="nft-grid">
          {assets.data.assets.map((asset) => (
            <MediaCard
              key={String(asset.tokenId)}
              asset={asset}
              wallet={wallet}
              onChanged={() => assets.refetch()}
            />
          ))}
        </div>
      ) : null}

      {blocked ?? <MintMedia wallet={wallet} onMinted={() => assets.refetch()} />}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// USDC vault
// ─────────────────────────────────────────────────────────────────────────────

export function UsdcVault() {
  const wallet = useWalletContext();
  const [depositAmount, setDepositAmount] = useState('');
  const approve = useOnchainAction();
  const deposit = useOnchainAction();
  const redeem = useOnchainAction();

  const vault = useQuery({
    queryKey: ['vault-position', wallet.address],
    queryFn: () => readVaultPosition(wallet.address),
    enabled: Boolean(stage2Contracts.usdcVault),
    retry: 1,
    refetchInterval: 20_000,
  });

  const blocked = guard(wallet, stage2Contracts.usdcVault, 'USDC VAULT');
  const data = vault.data;
  const depositUnits = depositAmount && Number(depositAmount) > 0
    ? parseUsdcAmount(depositAmount) : 0n;
  const needsApproval = data && depositUnits > 0n && data.allowanceUnits < depositUnits;
  const insufficient = data && depositUnits > (data.walletUsdcUnits ?? 0n);

  async function refresh() { await vault.refetch(); }

  return (
    <section className="page">
      <div className="stage2-header">
        <h1><sup>LAB B</sup> USDC VAULT</h1>
        <div className="stage2-meta">
          <span>VAULT <ArcScanLink value={stage2Contracts.usdcVault} /></span>
          <span>ERC-4626 — ASSET: ARC USDC</span>
        </div>
      </div>

      {!stage2Contracts.usdcVault ? (
        <Unavailable title="USDC VAULT NOT CONFIGURED" detail="No vault address is configured." />
      ) : null}
      {stage2Contracts.usdcVault && vault.isLoading
        ? <div className="empty"><span>READING ARC…</span></div> : null}
      {stage2Contracts.usdcVault && vault.isError ? (
        <Unavailable title="ARC RPC UNAVAILABLE" detail="The vault could not be read." />
      ) : null}

      {data?.configured ? (
        <>
          <div className="assets vault-totals">
            <div>
              <b>TOTAL VAULT ASSETS</b>
              <strong>{formatUsdcAmount(data.totalAssetsUnits)}</strong>
              <span>USDC HELD ONCHAIN</span>
            </div>
            <div>
              <b>YOUR POSITION</b>
              <strong>{formatUsdcAmount(data.redeemableUnits)}</strong>
              <span>REDEEMABLE USDC</span>
            </div>
            <div>
              <b>YOUR SHARES</b>
              <strong>{data.shares.toString()}</strong>
              <span>{data.shareSymbol} ({data.shareDecimals} DECIMALS)</span>
            </div>
            <div>
              <b>YIELD</b>
              <strong>{data.yieldBps} BPS</strong>
              <span>NO STRATEGY — NO YIELD IS GENERATED</span>
            </div>
          </div>

          {!data.assetIsArcUsdc ? (
            <Unavailable
              title="UNEXPECTED VAULT ASSET"
              detail="The configured vault does not hold Arc USDC. Deposits are disabled."
            />
          ) : null}

          {blocked ?? (
            <div className="vault-actions">
              <div className="vault-panel">
                <h3>DEPOSIT</h3>
                <p className="mint-note">
                  WALLET BALANCE: {formatUsdcAmount(data.walletUsdcUnits)} USDC
                </p>
                <label>
                  AMOUNT
                  <input
                    value={depositAmount}
                    onChange={(event) => setDepositAmount(event.target.value)}
                    placeholder="0.00"
                    inputMode="decimal"
                    aria-label="Deposit amount in USDC"
                  />
                  <small>USDC</small>
                </label>
                {insufficient ? <small className="tx-error">Insufficient USDC balance.</small> : null}
                {needsApproval ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={insufficient}
                    onClick={async () => {
                      await approve.execute({
                        address: arcContracts.usdc,
                        abi: usdcAbi,
                        functionName: 'approve',
                        args: [stage2Contracts.usdcVault, depositUnits],
                      });
                      await refresh();
                    }}
                  >
                    1. APPROVE {depositAmount} USDC
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn primary full"
                  disabled={depositUnits <= 0n || needsApproval || insufficient}
                  onClick={async () => {
                    await deposit.execute({
                      address: stage2Contracts.usdcVault,
                      abi: vaultAbi,
                      functionName: 'deposit',
                      args: [depositUnits, wallet.address],
                    });
                    setDepositAmount('');
                    await refresh();
                  }}
                >
                  DEPOSIT →
                </button>
                <TxStatus state={approve.state} label="APPROVE" />
                <TxStatus state={deposit.state} label="DEPOSIT" />
              </div>

              <div className="vault-panel">
                <h3>REDEEM</h3>
                {data.shares === 0n ? (
                  <p className="mint-note">NO VAULT POSITION YET.</p>
                ) : (
                  <>
                    <p className="mint-note">
                      REDEEMING ALL {data.shares.toString()} SHARES RETURNS{' '}
                      {formatUsdcAmount(data.redeemableUnits)} USDC.
                    </p>
                    <button
                      type="button"
                      className="btn primary full"
                      onClick={async () => {
                        await redeem.execute({
                          address: stage2Contracts.usdcVault,
                          abi: vaultAbi,
                          functionName: 'redeem',
                          args: [data.shares, wallet.address, wallet.address],
                        });
                        await refresh();
                      }}
                    >
                      REDEEM ALL →
                    </button>
                  </>
                )}
                <TxStatus state={redeem.state} label="REDEEM" />
              </div>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Autonomous agent evidence
// ─────────────────────────────────────────────────────────────────────────────

function Metric({ label, value, threshold, invert = false }) {
  const numeric = typeof value === 'number';
  const pass = !numeric || threshold === undefined
    ? null
    : (invert ? value <= threshold : value >= threshold);
  return (
    <div className={`agent-metric ${pass === null ? '' : pass ? 'pass' : 'fail'}`}>
      <dt>{label}</dt>
      <dd>{numeric ? value : '—'}</dd>
      {threshold !== undefined
        ? <small>{invert ? 'MAX' : 'MIN'} {threshold}</small>
        : null}
    </div>
  );
}

function PayoutEvidence({ payout }) {
  const verified = payout.reconciliation?.status === 'VERIFIED';
  return (
    <article className={`agent-payout ${verified ? 'verified' : ''}`}>
      <header>
        <div>
          <small>MARKET</small>
          <ArcScanLink value={payout.marketAddress} />
        </div>
        <div>
          <small>CREATOR</small>
          <ArcScanLink value={payout.creatorAddress} />
        </div>
        <div className="agent-amount">
          <small>CREATOR PAYOUT</small>
          <b>{payout.creatorPayoutUsdc ?? payout.amountUsdc} USDC</b>
        </div>
      </header>

      <div className="agent-chain">
        <span className="agent-step">
          <small>SIGNAL SOURCE</small>
          <b>{payout.provenance ?? '—'}</b>
        </span>
        <span className="agent-step">
          <small>EVIDENCE RANGE</small>
          <b>{payout.fromBlock ? `${payout.fromBlock} → ${payout.toBlock}` : '—'}</b>
        </span>
        <span className="agent-step">
          <small>POLICY</small>
          <b className={payout.outcome === 'EXECUTED' ? 'ok' : 'warn'}>
            {payout.outcome === 'EXECUTED' ? 'PASS' : (payout.outcome ?? 'PENDING')}
          </b>
        </span>
        <span className="agent-step">
          <small>EXECUTION MODE</small>
          <b>{payout.executionMode ?? '—'}</b>
        </span>
        <span className="agent-step">
          <small>HUMAN APPROVAL</small>
          <b className={payout.humanAuthorization ? 'warn' : 'ok'}>
            {payout.humanAuthorization === undefined ? '—' : payout.humanAuthorization ? 'YES' : 'NO'}
          </b>
        </span>
      </div>

      {payout.signals ? (
        <dl className="agent-metrics">
          <Metric label="ENGAGEMENT" value={payout.signals.engagementVelocity} />
          <Metric label="RETENTION" value={payout.signals.holderRetention} />
          <Metric label="LIQUIDITY" value={payout.signals.liquidityDepth} />
          <Metric label="CONFIDENCE" value={payout.signals.confidence} />
          <Metric label="RISK SCORE" value={payout.signals.fraudRisk} invert />
          <Metric label="SCORE" value={payout.score} />
        </dl>
      ) : null}

      {payout.riskReasons?.length ? (
        <p className="agent-reasons">RISK FLAGS: {payout.riskReasons.join(', ')}</p>
      ) : null}
      {payout.policyReasons?.length ? (
        <p className="agent-reasons">
          DENIAL REASONS: {payout.policyReasons.map((reason) => reason.code ?? reason).join(', ')}
        </p>
      ) : null}

      <footer className="agent-receipts">
        <span>EXECUTED BY <ArcScanLink value={payout.executedBy} /></span>
        <span>CIRCLE {payout.circleState ?? '—'}</span>
        <span>ARC TX <ArcScanLink kind="tx" value={payout.transactionHash} /></span>
        <span className={`recon ${verified ? 'ok' : 'warn'}`}>
          RECONCILIATION {payout.reconciliation?.status ?? 'PENDING'}
          {payout.reconciliation?.route ? ` (${payout.reconciliation.route})` : ''}
        </span>
        {payout.reconciliation?.failures?.length
          ? <span className="tx-error">{payout.reconciliation.failures.join(', ')}</span>
          : null}
        <span className="agent-digest" title={payout.evidenceDigest}>
          EVIDENCE {shorten(payout.evidenceDigest, 10, 8)}
        </span>
      </footer>
    </article>
  );
}

export function AutonomousAgentPanel() {
  const status = useQuery({
    queryKey: ['agent-autonomy'],
    queryFn: getAgentAutonomy,
    retry: 1,
    refetchInterval: 15_000,
  });

  if (status.isLoading) return <div className="empty"><span>READING AGENT STATUS…</span></div>;

  if (status.isError) {
    const notConfigured = status.error?.code === 'AGENT_NOT_CONFIGURED';
    return (
      <Unavailable
        title={notConfigured ? 'AUTONOMOUS AGENT NOT CONFIGURED' : 'AGENT STATUS UNAVAILABLE'}
        detail={notConfigured
          ? 'This deployment has no autonomous agent configured.'
          : 'The backend could not be reached. No cached decision is shown.'}
      />
    );
  }

  const data = status.data;
  const executor = data.executor ?? {};
  const state = data.paused ? 'PAUSED' : 'ACTIVE';

  return (
    <div className="agent-autonomy">
      <div className="stage2-header">
        <h2><sup>AUTONOMY</sup> AGENT EXECUTION</h2>
        <div className="stage2-meta">
          <span className={`agent-state ${data.paused ? 'paused' : 'active'}`}>{state}</span>
          {data.pauseReason ? <span>REASON: {data.pauseReason}</span> : null}
          <span>{data.policyVersion}</span>
        </div>
      </div>

      <div className="assets agent-summary">
        <div>
          <b>EXECUTOR</b>
          <strong>{executor.provider === 'CIRCLE_AGENT_WALLET' ? 'CIRCLE AGENT WALLET' : (executor.provider ?? 'NOT CONFIGURED')}</strong>
          <span>{executor.accountType ? `${executor.accountType} — ${executor.state}` : 'UNAVAILABLE'}</span>
          <span><ArcScanLink value={executor.address} /></span>
        </div>
        <div>
          <b>PER-EXECUTION CAP</b>
          <strong>{data.caps.perExecutionUsdc}</strong>
          <span>MIN {data.caps.minimumUsdc} USDC</span>
        </div>
        <div>
          <b>DAILY CAPS</b>
          <strong>{data.caps.globalDailyUsdc}</strong>
          <span>PER MARKET {data.caps.marketDailyUsdc} USDC</span>
        </div>
        <div>
          <b>GATES</b>
          <strong>{data.thresholds?.minConfidence ?? '—'} / {data.thresholds?.maxFraudRisk ?? '—'}</strong>
          <span>MIN CONFIDENCE / MAX RISK</span>
        </div>
      </div>

      <p className="mint-note">
        The agent derives its own recipient from <code>market.creator()</code>, its own payout from
        the decided score, and its own observation time from the Arc anchor block. No browser
        request can choose any of them, and no human approves an individual payout.
      </p>

      {data.recentEpochs.length === 0 ? (
        <Unavailable
          title="NO AUTONOMOUS DECISIONS YET"
          detail="The agent has not evaluated an eligible market in this deployment."
        />
      ) : (
        <div className="agent-payouts">
          {data.recentEpochs.map((payout) => (
            <PayoutEvidence key={`${payout.marketAddress}-${payout.epoch}`} payout={payout} />
          ))}
        </div>
      )}
    </div>
  );
}

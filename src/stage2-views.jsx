import React, { useMemo, useState } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { keccak256 } from 'viem';
import { arc, arcContracts } from './arc';
import { usdcAbi } from './market';
import {
  formatUsdcAmount,
  jsonDataUri,
  mediaNftAbi,
  nftMarketplaceAbi,
  readCreatableMarkets,
  readMediaAssets,
  readMarketplaceAllowance,
  readVaultPosition,
  safeMediaUrl,
  stage2Contracts,
  usdcAmountUnits,
  vaultAbi,
} from './assets';
import { useOnchainAction } from './use-onchain-action';

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
  // Minter-supplied and therefore untrusted: anything that is not https or a data: image is
  // refused outright rather than handed to the browser as an attribute.
  const image = safeMediaUrl(asset.metadata?.image);
  // The exact units the listing call will send, or null when the field cannot become one. The
  // button gates on this rather than on Number(), which reports NaN for "abc" and let the guard
  // pass — enabling a transaction whose own parser would then throw.
  const priceUnits = usdcAmountUnits(price);

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
          ? (
            /*
              The host is chosen by whoever minted the token, so the request must not tell it
              which MemeVerse page the visitor is on. The document-level referrer meta covers
              this too; the attribute states it on the element that actually reaches a
              third-party host, where the guarantee has to hold.
            */
            <img
              src={image}
              alt={asset.metadata?.name ?? `MemeVerse media #${asset.tokenId}`}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          )
          : <span className="media-missing">
            {asset.metadata?.image ? 'MEDIA URI NOT RENDERABLE' : 'NO MEDIA URI'}
          </span>}
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
            <dt>CONTENT HASH (COMMITMENT)</dt>
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
                type="number"
                inputMode="decimal"
                min="0.000001"
                step="0.000001"
                aria-label="Listing price in USDC"
                aria-invalid={price.trim() !== '' && priceUnits === null ? 'true' : undefined}
              />
              <small>USDC</small>
            </label>
            {price.trim() !== '' && priceUnits === null ? (
              <small className="tx-error">
                Enter a positive USDC amount with at most 6 decimal places.
              </small>
            ) : null}
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
              disabled={priceUnits === null}
              onClick={() => run(list, {
                address: stage2Contracts.nftMarketplace,
                abi: nftMarketplaceAbi,
                functionName: 'list',
                args: [asset.tokenId, priceUnits],
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
    // Encoded through the UTF-8-safe helper, because a meme name is exactly where emoji and
    // non-Latin script show up and raw btoa throws on both.
    return jsonDataUri(metadata);
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
        are its <code>creator()</code>. Provenance cannot be forged from the browser. The content
        hash is your onchain <em>commitment</em> to the media bytes — the contract stores and
        de-duplicates it but cannot fetch the URL to check it, so anyone can recompute the digest
        from the file and compare it against the commitment.
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
        <h1><sup>03 OWN</sup> CREATOR MEDIA</h1>
        <p className="surface-lede">
          Creators mint media only against markets they actually created; the contract checks that
          provenance onchain before a token can exist. Media then trades for USDC like any other
          asset in the economy.
        </p>
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
  // Same question the deposit call will ask, asked with the same parser. `Number()` alone reports
  // NaN for a malformed entry, and `NaN > 0` being false only accidentally produced the right
  // answer here — an explicit parse says so on purpose.
  const depositUnits = usdcAmountUnits(depositAmount) ?? 0n;
  const depositMalformed = depositAmount.trim() !== '' && usdcAmountUnits(depositAmount) === null;
  const needsApproval = data && depositUnits > 0n && data.allowanceUnits < depositUnits;
  const insufficient = data && depositUnits > (data.walletUsdcUnits ?? 0n);

  async function refresh() { await vault.refetch(); }

  return (
    <section className="page">
      <div className="stage2-header">
        <h1><sup>SUPPORTING</sup> PROGRAMMABLE TREASURY</h1>
        <p className="surface-lede">
          A real ERC-4626 vault over Arc USDC — the composable treasury primitive a MemeVerse
          creator or DAO would hold funds in. It runs no strategy and generates no yield, and it
          says so onchain: <code>annualPercentageYieldBps</code> returns zero. Deposits are idle
          USDC, fully redeemable.
        </p>
        <div className="stage2-meta">
          <span>VAULT <ArcScanLink value={stage2Contracts.usdcVault} /></span>
          <span>ERC-4626 — ASSET: ARC USDC</span>
          <span>NO STRATEGY — NO YIELD</span>
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
              <span>READ FROM THE CONTRACT — NOT ASSUMED</span>
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
                    type="number"
                    inputMode="decimal"
                    min="0.000001"
                    step="0.000001"
                    aria-label="Deposit amount in USDC"
                    aria-invalid={depositMalformed ? 'true' : undefined}
                  />
                  <small>USDC</small>
                </label>
                {depositMalformed ? (
                  <small className="tx-error">
                    Enter a positive USDC amount with at most 6 decimal places.
                  </small>
                ) : null}
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

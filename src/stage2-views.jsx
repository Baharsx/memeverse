import React, { useMemo, useState } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
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
import { MEDIA_ACTIONS } from './media-authorization';
import { publicMediaAssets } from './media-display';
import {
  AttachImageButton,
  ImagePicker,
  mediaContentUrl,
  useImageSelection,
  useMediaUpload,
} from './media-views.jsx';

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

  /*
    Runs a marketplace transaction and refreshes the card afterwards.

    A declined wallet prompt is an ordinary outcome, not a crash: `execute` records it on the
    action's own state — which `TxStatus` renders — and then rethrows. Left uncaught in an async
    click handler that became an unhandled promise rejection in the console while the user saw a
    perfectly good error message. Swallowing it here matches how the Markets page already treats
    the same situation, and the refresh is skipped because nothing changed onchain.
  */
  async function run(action, request) {
    try {
      await action.execute(request);
    } catch {
      return; // The action state presents the wallet/provider error.
    }
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
            {/* Which side of the marketplace this panel is. Stated as text rather than implied by
                colour, so the intent survives for anyone who cannot distinguish the accent. */}
            <span className="marketplace-mode">MARKETPLACE ACTION // SELL</span>
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
              2. LIST FOR SALE →
            </button>
            <TxStatus state={approveNft.state} label="APPROVE" />
            {/* `list()` offers the token at a price; it does not move it and nobody has bought
                anything yet. Labelling this transaction "SELL" would announce a sale that has not
                happened. */}
            <TxStatus state={list.state} label="LIST FOR SALE" />
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
            <span className="marketplace-mode buy">MARKETPLACE ACTION // BUY</span>
            {(allowance.data ?? 0n) < listing.priceUnits ? (
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  try {
                    await approveUsdc.execute({
                      address: arcContracts.usdc,
                      abi: usdcAbi,
                      functionName: 'approve',
                      args: [stage2Contracts.nftMarketplace, listing.priceUnits],
                    });
                  } catch {
                    return; // Reported by TxStatus below; BUY simply stays disabled.
                  }
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
  const [form, setForm] = useState({ market: '', name: '' });
  const [advanced, setAdvanced] = useState(false);
  // The manual path this panel has always had. It is no longer how anyone mints normally, but a
  // creator who already hosts their media somewhere should not be forced to re-upload it here.
  const [manual, setManual] = useState({ mediaUrl: '', contentHash: '' });
  const mint = useOnchainAction();
  const image = useImageSelection();

  const markets = useQuery({
    queryKey: ['creatable-markets', wallet.address],
    queryFn: () => readCreatableMarkets(wallet.address),
    enabled: Boolean(wallet.address) && !wallet.wrongNetwork,
    staleTime: 30_000,
  });

  const upload = useMediaUpload({
    action: MEDIA_ACTIONS.NFT_MEDIA,
    market: form.market || undefined,
    selection: image.selection,
  });

  /*
    Where the media actually is, and what the onchain commitment covers.

    In the normal flow both come from one verified upload: the URL is the same-origin address the
    server returned, and the hash is the digest the server independently recomputed from the exact
    bytes it received. They cannot describe different files, because the upload is only treated as
    successful when the server's hash matches the one the browser signed over.
  */
  const uploaded = upload.state.status === 'UPLOADED' ? upload.state.result : null;
  const uploadedUrl = uploaded ? mediaContentUrl(uploaded.url) : null;
  const absoluteUploadedUrl = uploadedUrl
    ? new URL(uploadedUrl, window.location.origin).toString()
    : null;

  const manualHashValid = /^0x[a-fA-F0-9]{64}$/.test(manual.contentHash);
  const usingManual = advanced && Boolean(manual.mediaUrl.trim()) && manualHashValid;

  const mediaUrl = usingManual ? manual.mediaUrl.trim() : absoluteUploadedUrl;
  const contentHash = usingManual ? manual.contentHash : uploaded?.contentHash ?? '';
  const validHash = /^0x[a-fA-F0-9]{64}$/.test(contentHash);
  const canMint = Boolean(form.market) && validHash && Boolean(mediaUrl);
  /*
    The digest shown to the creator, which is not the same thing as the digest that may be minted.
    A freshly picked file has a locally computed hash immediately — useful to see — but it only
    becomes mintable once the server has recomputed it from the bytes it actually received.
  */
  const displayHash = usingManual
    ? manual.contentHash
    : uploaded?.contentHash ?? image.selection?.contentHash ?? '';

  const metadataUri = useMemo(() => {
    if (!canMint) return null;
    const metadata = {
      name: form.name.trim() || 'MemeVerse Media',
      description: 'MemeVerse media asset bound onchain to a registered MemeVerse market.',
      image: mediaUrl,
      attributes: [
        { trait_type: 'market', value: form.market },
        { trait_type: 'creator', value: wallet.address },
        { trait_type: 'contentHash', value: contentHash },
        { trait_type: 'contentHashScheme', value: 'keccak256(file bytes)' },
      ],
    };
    // Self-contained metadata: no host is required for it to stay resolvable or verifiable.
    // Encoded through the UTF-8-safe helper, because a meme name is exactly where emoji and
    // non-Latin script show up and raw btoa throws on both.
    return jsonDataUri(metadata);
  }, [canMint, form.market, form.name, mediaUrl, contentHash, wallet.address]);

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
      <ImagePicker
        id="mint-media-file"
        label="IMAGE FILE"
        hint="PNG, JPEG, or WebP, up to 5 MB. The digest below is computed from these exact bytes."
        selection={image.selection}
        error={image.error}
        onSelect={image.select}
        onClear={image.clear}
        disabled={!form.market}
      />
      {!form.market && image.selection
        ? <small className="tx-error">Select a market before uploading.</small>
        : null}
      <label>
        NAME
        <input
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="MemeVerse Media"
        />
      </label>
      {/*
        The commitment is read-only and derived, never typed. It is the keccak256 of the bytes the
        picker read, and the mint below sends exactly this value — so what the contract stores and
        what anyone can recompute from the file are the same number by construction.
      */}
      <label>
        CONTENT COMMITMENT
        <output className="content-commitment">
          {displayHash || 'SELECT AN IMAGE FILE'}
        </output>
        <small>
          {contentHash
            ? 'keccak256 of the exact file bytes — verified by the server'
            : displayHash
              ? 'keccak256 of the exact file bytes — upload to verify before minting'
              : 'keccak256 of the exact file bytes'}
        </small>
      </label>
      {image.selection && !usingManual ? (
        <AttachImageButton
          state={upload.state}
          onStart={upload.start}
          disabled={!form.market}
        >
          SIGN + UPLOAD IMAGE →
        </AttachImageButton>
      ) : null}
      {uploaded ? (
        <div className="upload-receipt" role="status">
          <b>IMAGE HOSTED + HASH VERIFIED</b>
          <span>The server independently recomputed this digest from the uploaded bytes and it matches what you signed.</span>
        </div>
      ) : null}
      <details
        className="advanced-media"
        open={advanced}
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
      >
        <summary>ADVANCED — USE AN EXTERNAL MEDIA URL</summary>
        <p className="mint-note">
          For media you already host. You are responsible for the URL staying resolvable and for
          the hash matching its bytes; nothing here verifies either.
        </p>
        <label>
          MEDIA URL
          <input
            value={manual.mediaUrl}
            onChange={(event) => setManual({ ...manual, mediaUrl: event.target.value })}
            placeholder="https://…"
          />
        </label>
        <label>
          CONTENT HASH
          <input
            value={manual.contentHash}
            onChange={(event) => setManual({ ...manual, contentHash: event.target.value })}
            placeholder="0x… (64 hex)"
          />
          {manual.contentHash && !manualHashValid
            ? <small className="tx-error">Not a 32-byte hash.</small>
            : null}
        </label>
        {usingManual
          ? <small className="media-status">EXTERNAL URL MODE ACTIVE — the upload above is ignored.</small>
          : null}
      </details>
      <button
        type="button"
        className="btn primary full"
        disabled={!canMint}
        onClick={async () => {
          await mint.execute({
            address: stage2Contracts.mediaNft,
            abi: mediaNftAbi,
            functionName: 'mint',
            // Exactly the digest the server verified against the uploaded bytes — or, in advanced
            // mode, the one the creator vouched for. Never a separately typed third value.
            args: [form.market, contentHash, metadataUri],
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
  /*
    What the gallery shows: the whole collection minus the project's own early test mint. The
    contract enumeration in `assets.data.assets` is untouched and still describes every token on
    Arc — this is the presentation view of it, and it is the only thing rendered below.
  */
  const visibleAssets = publicMediaAssets(assets.data?.assets);

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

      {assets.data?.configured && visibleAssets.length === 0 ? (
        <Unavailable title="NO MEDIA MINTED YET" detail="This collection is empty on Arc." />
      ) : null}

      {visibleAssets.length ? (
        <div className="nft-grid">
          {visibleAssets.map((asset) => (
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

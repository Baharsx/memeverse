import { formatUnits, getAddress, parseAbi, parseUnits } from 'viem';
import { arcContracts } from './arc.js';
import { marketPublicClient, marketAbi, USDC_DECIMALS, usdcAbi } from './market.js';

/**
 * Browser-side reads and write descriptors for the Stage 2 Arc contracts: the media NFT
 * collection, its USDC marketplace, and the USDC vault.
 *
 * Everything here reads deployed contract state over the Arc RPC. There is no placeholder data
 * and no optimistic local state: when an address is not configured the caller renders an
 * explicit "not configured" surface rather than inventing a collection.
 */

const ZERO = '0x0000000000000000000000000000000000000000';

// `import.meta.env` only exists under Vite. Defaulting it keeps these helpers importable from
// plain Node so the pure logic below can be unit tested without a bundler.
const viteEnv = import.meta.env ?? {};

function configuredAddress(value) {
  const trimmed = value?.trim();
  if (!trimmed || !/^0x[a-fA-F0-9]{40}$/.test(trimmed) || trimmed === ZERO) return null;
  return getAddress(trimmed);
}

export { configuredAddress };

export const stage2Contracts = Object.freeze({
  mediaNft: configuredAddress(viteEnv.VITE_MEDIA_NFT_ADDRESS),
  nftMarketplace: configuredAddress(viteEnv.VITE_NFT_MARKETPLACE_ADDRESS),
  usdcVault: configuredAddress(viteEnv.VITE_USDC_VAULT_ADDRESS),
});

export const mediaNftAbi = parseAbi([
  'function factory() view returns (address)',
  'function totalMinted() view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function tokenIdForContentHash(bytes32 contentHash) view returns (uint256)',
  'function provenanceOf(uint256 tokenId) view returns ((address creator,address market,bytes32 contentHash,uint64 mintedAtBlock,uint64 mintedAt))',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner,address operator) view returns (bool)',
  'function approve(address to,uint256 tokenId)',
  'function mint(address market,bytes32 contentHash,string metadataUri) returns (uint256)',
]);

export const nftMarketplaceAbi = parseAbi([
  'function nft() view returns (address)',
  'function usdc() view returns (address)',
  'function listings(uint256 tokenId) view returns (address seller,uint256 priceUsdc,uint64 listedAt)',
  'function isFillable(uint256 tokenId) view returns (bool)',
  'function list(uint256 tokenId,uint256 priceUsdc)',
  'function cancel(uint256 tokenId)',
  'function buy(uint256 tokenId)',
]);

export const vaultAbi = parseAbi([
  'function asset() view returns (address)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function maxWithdraw(address owner) view returns (uint256)',
  'function previewDeposit(uint256 assets) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
  'function annualPercentageYieldBps() pure returns (uint256)',
  'function deposit(uint256 assets,address receiver) returns (uint256)',
  'function redeem(uint256 shares,address receiver,address owner) returns (uint256)',
]);

export function formatUsdcAmount(units, maximumFractionDigits = 6) {
  if (units === undefined || units === null) return '—';
  const value = Number(formatUnits(BigInt(units), USDC_DECIMALS));
  return value.toLocaleString(undefined, { maximumFractionDigits });
}

export function parseUsdcAmount(value) {
  return parseUnits(String(value), USDC_DECIMALS);
}

/**
 * The atomic USDC units a user-entered amount really represents, or null if it does not represent
 * one at all.
 *
 * Gating a transaction on `Number(value) <= 0` is not the same question as "can this be parsed".
 * `Number('abc')` is `NaN`, and `NaN <= 0` is false — so a field containing `abc` passed the guard
 * and the button enabled, leaving `parseUnits` to throw at click time on a value the interface had
 * already told the user was fine. This asks the question the transaction will actually ask, using
 * the same parser, so the button's enabled state and the call's success cannot disagree.
 */
export function usdcAmountUnits(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const trimmed = String(value).trim();
  // parseUnits accepts leading '+', exponent notation, and other shapes the contract's decimal
  // amount is not; require a plain non-negative decimal with at most six places up front.
  if (!/^\d{1,18}(?:\.\d{1,6})?$/.test(trimmed)) return null;
  try {
    const units = parseUsdcAmount(trimmed);
    return units > 0n ? units : null;
  } catch {
    return null;
  }
}

/**
 * Reads every minted media asset with its provenance, owner, and live listing.
 *
 * The collection is enumerated from `totalMinted` rather than by scanning logs. Arc's public RPC
 * caps and rate-limits `eth_getLogs`, and a throttled scan would silently render an incomplete
 * gallery; a bounded id walk always shows the true collection.
 */
export async function readMediaAssets({ limit = 60 } = {}) {
  const nft = stage2Contracts.mediaNft;
  if (!nft) return { configured: false, assets: [], totalMinted: 0 };

  const totalMinted = await marketPublicClient.readContract({
    address: nft, abi: mediaNftAbi, functionName: 'totalMinted',
  });
  const count = Number(totalMinted);
  const newestFirst = [];
  for (let tokenId = count; tokenId > 0 && newestFirst.length < limit; tokenId -= 1) {
    newestFirst.push(BigInt(tokenId));
  }

  const assets = await Promise.all(newestFirst.map(async (tokenId) => {
    const [owner, tokenUri, provenance] = await Promise.all([
      marketPublicClient.readContract({ address: nft, abi: mediaNftAbi, functionName: 'ownerOf', args: [tokenId] }),
      marketPublicClient.readContract({ address: nft, abi: mediaNftAbi, functionName: 'tokenURI', args: [tokenId] }),
      marketPublicClient.readContract({ address: nft, abi: mediaNftAbi, functionName: 'provenanceOf', args: [tokenId] }),
    ]);

    let listing = null;
    if (stage2Contracts.nftMarketplace) {
      const [seller, priceUsdc, listedAt] = await marketPublicClient.readContract({
        address: stage2Contracts.nftMarketplace,
        abi: nftMarketplaceAbi,
        functionName: 'listings',
        args: [tokenId],
      });
      if (seller !== ZERO) {
        const fillable = await marketPublicClient.readContract({
          address: stage2Contracts.nftMarketplace,
          abi: nftMarketplaceAbi,
          functionName: 'isFillable',
          args: [tokenId],
        });
        listing = {
          seller: getAddress(seller),
          priceUnits: priceUsdc,
          priceUsdc: formatUsdcAmount(priceUsdc),
          listedAt: Number(listedAt),
          // A listing whose seller has moved the token or revoked approval is shown as stale
          // rather than offered as buyable.
          fillable,
        };
      }
    }

    return {
      tokenId,
      owner: getAddress(owner),
      tokenUri,
      metadata: decodeMetadata(tokenUri),
      creator: getAddress(provenance.creator),
      market: getAddress(provenance.market),
      contentHash: provenance.contentHash,
      mintedAtBlock: Number(provenance.mintedAtBlock),
      mintedAt: Number(provenance.mintedAt),
      listing,
    };
  }));

  return { configured: true, assets, totalMinted: count };
}

/**
 * The only media URLs the gallery will put in an `<img src>`.
 *
 * Token metadata is written by whoever minted the token, so it is untrusted input that this
 * application renders to every other visitor. React escapes text, but a URL handed to an
 * attribute is not text: `javascript:`, `blob:`, and non-image `data:` payloads all have to be
 * refused here rather than relied on the browser to ignore. Anything that is not plain `https:`
 * or a `data:image/…` payload returns null, and the card renders an explicit "unrenderable media"
 * state instead of a silently broken image.
 */
export function safeMediaUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (/^data:image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(trimmed)) {
    return trimmed;
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // https only. Plain http would be blocked as mixed content on a TLS deployment anyway, and
  // permitting it here would only produce a broken image with no explanation.
  if (url.protocol !== 'https:') return null;
  return url.toString();
}

const JSON_DATA_URI_PREFIX = 'data:application/json;base64,';

/**
 * Encodes token metadata as a self-contained `data:application/json;base64` URI, UTF-8 safe.
 *
 * `btoa` is defined over Latin-1 code units, so `btoa(JSON.stringify(…))` throws
 * `InvalidCharacterError` on any character above U+00FF. That is not an exotic edge case for a
 * meme platform — `DOGE 🚀`, `میم ایرانی`, and `猫コイン` are all exactly the names people would
 * type, and the failure landed while *rendering* the mint panel rather than on submit, so the
 * surface broke before the user could click anything. Encoding the UTF-8 bytes first is the fix.
 */
export function jsonDataUri(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  // btoa needs one character per byte. Chunked so a large metadata blob cannot blow the argument
  // limit of String.fromCharCode(...spread).
  let binary = '';
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return `${JSON_DATA_URI_PREFIX}${btoa(binary)}`;
}

/**
 * Decodes the self-contained `data:application/json;base64` metadata a mint writes.
 *
 * The mirror of the problem above: `JSON.parse(atob(…))` reads each byte as a code unit, so a
 * multi-byte character comes back mojibake — or fails outright. The bytes are decoded as UTF-8.
 * Malformed, hostile, or absent input still resolves to null rather than throwing into the UI.
 */
export function decodeMetadata(tokenUri) {
  if (typeof tokenUri !== 'string') return null;
  if (!tokenUri.startsWith(JSON_DATA_URI_PREFIX)) return null;
  try {
    const binary = atob(tokenUri.slice(JSON_DATA_URI_PREFIX.length));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/** Which registered markets the connected wallet created, and can therefore mint media for. */
export async function readCreatableMarkets(account) {
  if (!account) return [];
  const count = await marketPublicClient.readContract({
    address: arcContracts.memeVerseFactory, abi: factoryAbiMinimal, functionName: 'marketCount',
  });
  const markets = [];
  for (let index = 0n; index < count; index += 1n) {
    const market = await marketPublicClient.readContract({
      address: arcContracts.memeVerseFactory, abi: factoryAbiMinimal, functionName: 'markets', args: [index],
    });
    const [creator, symbol, name] = await Promise.all([
      marketPublicClient.readContract({ address: market, abi: marketAbi, functionName: 'creator' }),
      marketPublicClient.readContract({ address: market, abi: marketAbi, functionName: 'symbol' }),
      marketPublicClient.readContract({ address: market, abi: marketAbi, functionName: 'name' }),
    ]);
    if (getAddress(creator) === getAddress(account)) {
      markets.push({ address: getAddress(market), symbol, name });
    }
  }
  return markets;
}

const factoryAbiMinimal = parseAbi([
  'function marketCount() view returns (uint256)',
  'function markets(uint256 index) view returns (address)',
]);

/** The connected wallet's real vault position plus the vault's own totals. */
export async function readVaultPosition(account) {
  const vault = stage2Contracts.usdcVault;
  if (!vault) return { configured: false };

  const [asset, symbol, decimals, totalAssets, totalSupply, yieldBps] = await Promise.all([
    marketPublicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'asset' }),
    marketPublicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'symbol' }),
    marketPublicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'decimals' }),
    marketPublicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'totalAssets' }),
    marketPublicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'totalSupply' }),
    marketPublicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'annualPercentageYieldBps' }),
  ]);

  const position = account
    ? await Promise.all([
      marketPublicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [account] }),
      marketPublicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'maxWithdraw', args: [account] }),
      marketPublicClient.readContract({ address: arcContracts.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [account] }),
      marketPublicClient.readContract({ address: arcContracts.usdc, abi: usdcAbi, functionName: 'allowance', args: [account, vault] }),
    ])
    : [0n, 0n, 0n, 0n];

  return {
    configured: true,
    address: vault,
    asset: getAddress(asset),
    assetIsArcUsdc: getAddress(asset) === getAddress(arcContracts.usdc),
    shareSymbol: symbol,
    shareDecimals: Number(decimals),
    totalAssetsUnits: totalAssets,
    totalSupplyShares: totalSupply,
    // The vault runs no strategy. This is read from the contract rather than assumed.
    yieldBps: Number(yieldBps),
    shares: position[0],
    redeemableUnits: position[1],
    walletUsdcUnits: position[2],
    allowanceUnits: position[3],
  };
}

/** Whether the connected wallet has approved the marketplace for one token. */
export async function readNftApproval({ tokenId, owner }) {
  const nft = stage2Contracts.mediaNft;
  const marketplace = stage2Contracts.nftMarketplace;
  if (!nft || !marketplace || !owner) return false;
  const [approved, approvedForAll] = await Promise.all([
    marketPublicClient.readContract({ address: nft, abi: mediaNftAbi, functionName: 'getApproved', args: [tokenId] }),
    marketPublicClient.readContract({ address: nft, abi: mediaNftAbi, functionName: 'isApprovedForAll', args: [owner, marketplace] }),
  ]);
  return getAddress(approved) === marketplace || approvedForAll;
}

/** USDC allowance granted to the marketplace by the connected wallet. */
export async function readMarketplaceAllowance(account) {
  const marketplace = stage2Contracts.nftMarketplace;
  if (!marketplace || !account) return 0n;
  return marketPublicClient.readContract({
    address: arcContracts.usdc, abi: usdcAbi, functionName: 'allowance', args: [account, marketplace],
  });
}

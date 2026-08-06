import { readFile } from 'node:fs/promises';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import {
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseUnits,
} from 'viem';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';
import { circleIdempotencyKey } from './circle-idempotency.js';

/**
 * Live Arc Testnet end-to-end proof for the Stage 2 media layer:
 * mint with real market provenance -> list in USDC -> purchase by a second real wallet.
 *
 * Every assertion is read back from Arc after the receipt, including both parties' USDC deltas.
 * Nothing is simulated: the seller is the genuine onchain creator of a registered MemeVerse
 * market, and the buyer is a separate funded Circle wallet.
 *
 * Provenance hashing scheme: `contentHash = keccak256(<exact media file bytes>)`. The digest is
 * recomputable by anyone holding the same file, and the metadata URI carries that digest so the
 * asset's identity can be checked independently of the URI's host.
 */

loadLocalEnvironment();
const config = loadServerConfig();

const ARC_CHAIN_ID = 5042002;
const MEDIA_FILE = 'public/memeverse-mark.png';
const MEDIA_URL = 'https://raw.githubusercontent.com/Baharsx/memeverse/main/public/memeverse-mark.png';
const LIST_PRICE_USDC = process.env.NFT_E2E_PRICE_USDC ?? '0.25';

const required = {
  MEDIA_NFT_ADDRESS: process.env.MEDIA_NFT_ADDRESS,
  NFT_MARKETPLACE_ADDRESS: process.env.NFT_MARKETPLACE_ADDRESS,
  CIRCLE_COUNTERPARTY_WALLET_ID: process.env.CIRCLE_COUNTERPARTY_WALLET_ID,
};
for (const [key, value] of Object.entries(required)) {
  if (!value) {
    console.error(`${key} is required. Run circle:deploy:assets and circle:setup:counterparty first.`);
    process.exit(1);
  }
}

const rpc = createPublicClient({ transport: http(config.arcRpcUrl) });
const chainId = await rpc.getChainId();
if (chainId !== ARC_CHAIN_ID) {
  console.error(`Refusing to run: chain ${chainId}, expected ${ARC_CHAIN_ID}.`);
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey: config.circleApiKey,
  entitySecret: config.circleEntitySecret,
  baseUrl: config.circleApiBaseUrl,
});

const nftAbi = JSON.parse(await readFile('contracts/artifacts/MemeVerseMediaNFT.json', 'utf8')).abi;
const marketAbi = JSON.parse(await readFile('contracts/artifacts/MemeVerseNFTMarketplace.json', 'utf8')).abi;
const factoryAbi = JSON.parse(await readFile('contracts/artifacts/MemeVerseFactory.json', 'utf8')).abi;
const memeMarketAbi = JSON.parse(await readFile('contracts/artifacts/MemeMarket.json', 'utf8')).abi;

const nftAddress = getAddress(process.env.MEDIA_NFT_ADDRESS);
const marketplaceAddress = getAddress(process.env.NFT_MARKETPLACE_ADDRESS);
const usdcAddress = getAddress(config.arcUsdcAddress);
const factoryAddress = getAddress(config.marketFactoryAddress);

const usdcAbi = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const balanceOf = (owner) => rpc.readContract({
  address: usdcAddress, abi: usdcAbi, functionName: 'balanceOf', args: [getAddress(owner)],
});

const writes = [];

/** Submits one contract call through Circle and waits for a confirmed Arc receipt. */
async function execute({ walletId, to, data, label, scope }) {
  const response = await client.createContractExecutionTransaction({
    idempotencyKey: circleIdempotencyKey(scope, [walletId, to, data]),
    walletId,
    contractAddress: to,
    callData: data,
    fee: { type: 'level', config: { feeLevel: config.circleFeeLevel } },
  });
  const id = response.data?.id;
  if (!id) throw new Error(`Circle returned no transaction ID for ${label}.`);

  let transaction;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const status = await client.getTransaction({ id });
    transaction = status.data?.transaction;
    if (['COMPLETE', 'CONFIRMED'].includes(transaction?.state)) break;
    if (['FAILED', 'DENIED', 'CANCELLED'].includes(transaction?.state)) {
      throw new Error(`${label} ended in ${transaction.state}: ${transaction.errorReason ?? 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!transaction?.txHash) throw new Error(`${label} produced no Arc transaction hash.`);

  // Never trust the provider's state alone: confirm the Arc receipt itself succeeded.
  const receipt = await rpc.waitForTransactionReceipt({ hash: transaction.txHash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted on Arc (${transaction.txHash}).`);

  writes.push({ label, txHash: transaction.txHash, blockNumber: receipt.blockNumber.toString() });
  console.log(`  ${label}`);
  console.log(`    tx:    ${transaction.txHash}`);
  console.log(`    block: ${receipt.blockNumber}`);
  return { transaction, receipt };
}

try {
  // ── Establish the real creator identity from the chain, never from configuration ──
  const treasury = (await client.getWallet({ id: config.circleWalletId })).data.wallet;
  const buyer = (await client.getWallet({ id: process.env.CIRCLE_COUNTERPARTY_WALLET_ID })).data.wallet;
  const sellerAddress = getAddress(treasury.address);
  const buyerAddress = getAddress(buyer.address);

  const marketAddress = getAddress(await rpc.readContract({
    address: factoryAddress, abi: factoryAbi, functionName: 'markets', args: [0n],
  }));
  const registered = await rpc.readContract({
    address: factoryAddress, abi: factoryAbi, functionName: 'isMarket', args: [marketAddress],
  });
  const marketCreator = getAddress(await rpc.readContract({
    address: marketAddress, abi: memeMarketAbi, functionName: 'creator',
  }));
  if (!registered) throw new Error(`${marketAddress} is not registered in the trusted factory.`);
  if (marketCreator !== sellerAddress) {
    throw new Error(`Minting wallet ${sellerAddress} is not the market creator ${marketCreator}.`);
  }

  console.log('MemeVerse NFT end-to-end on Arc Testnet');
  console.log(`  chain:       ${chainId}`);
  console.log(`  market:      ${marketAddress} (registered: ${registered})`);
  console.log(`  creator:     ${marketCreator}`);
  console.log(`  buyer:       ${buyerAddress}`);
  console.log(`  nft:         ${nftAddress}`);
  console.log(`  marketplace: ${marketplaceAddress}`);

  // ── Real content hash over the real repository media bytes ──
  const mediaBytes = await readFile(MEDIA_FILE);
  const contentHash = keccak256(mediaBytes);
  const metadata = {
    name: 'MemeVerse Genesis Mark',
    description: 'MemeVerse media asset bound onchain to a registered MemeVerse market.',
    image: MEDIA_URL,
    attributes: [
      { trait_type: 'market', value: marketAddress },
      { trait_type: 'creator', value: marketCreator },
      { trait_type: 'contentHash', value: contentHash },
      { trait_type: 'contentHashScheme', value: 'keccak256(file bytes)' },
      { trait_type: 'chainId', value: String(ARC_CHAIN_ID) },
    ],
  };
  // A self-contained data URI: the metadata needs no host to stay resolvable or verifiable.
  const metadataUri = `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString('base64')}`;

  console.log(`\n  media file:   ${MEDIA_FILE} (${mediaBytes.length} bytes)`);
  console.log(`  contentHash:  ${contentHash}`);
  console.log(`  scheme:       keccak256(file bytes)`);

  // ── Mint ──
  console.log('\n[1/4] Mint');
  await execute({
    walletId: config.circleWalletId,
    to: nftAddress,
    data: encodeFunctionData({
      abi: nftAbi, functionName: 'mint', args: [marketAddress, contentHash, metadataUri],
    }),
    label: 'mint media NFT',
    scope: 'nft-e2e-mint',
  });

  const tokenId = await rpc.readContract({
    address: nftAddress, abi: nftAbi, functionName: 'tokenIdForContentHash', args: [contentHash],
  });
  if (tokenId === 0n) throw new Error('Mint did not register the content hash.');

  const provenance = await rpc.readContract({
    address: nftAddress, abi: nftAbi, functionName: 'provenanceOf', args: [tokenId],
  });
  const owner = getAddress(await rpc.readContract({
    address: nftAddress, abi: nftAbi, functionName: 'ownerOf', args: [tokenId],
  }));
  console.log(`    tokenId:      ${tokenId}`);
  console.log(`    owner:        ${owner}`);
  console.log(`    prov.creator: ${getAddress(provenance.creator)}`);
  console.log(`    prov.market:  ${getAddress(provenance.market)}`);
  console.log(`    prov.hash:    ${provenance.contentHash}`);
  if (getAddress(provenance.creator) !== marketCreator) throw new Error('Provenance creator mismatch.');
  if (getAddress(provenance.market) !== marketAddress) throw new Error('Provenance market mismatch.');
  if (provenance.contentHash !== contentHash) throw new Error('Provenance content hash mismatch.');
  if (owner !== sellerAddress) throw new Error('Mint did not assign ownership to the creator.');

  // ── Approve and list ──
  console.log('\n[2/4] Approve marketplace and list');
  await execute({
    walletId: config.circleWalletId,
    to: nftAddress,
    data: encodeFunctionData({
      abi: nftAbi, functionName: 'approve', args: [marketplaceAddress, tokenId],
    }),
    label: 'approve marketplace for token',
    scope: 'nft-e2e-approve-nft',
  });

  const priceUnits = parseUnits(LIST_PRICE_USDC, 6);
  await execute({
    walletId: config.circleWalletId,
    to: marketplaceAddress,
    data: encodeFunctionData({
      abi: marketAbi, functionName: 'list', args: [tokenId, priceUnits],
    }),
    label: `list token for ${LIST_PRICE_USDC} USDC`,
    scope: 'nft-e2e-list',
  });

  const listing = await rpc.readContract({
    address: marketplaceAddress, abi: marketAbi, functionName: 'listings', args: [tokenId],
  });
  const fillable = await rpc.readContract({
    address: marketplaceAddress, abi: marketAbi, functionName: 'isFillable', args: [tokenId],
  });
  console.log(`    seller:   ${getAddress(listing[0])}`);
  console.log(`    price:    ${formatUnits(listing[1], 6)} USDC`);
  console.log(`    fillable: ${fillable}`);
  if (listing[1] !== priceUnits) throw new Error('Listing price mismatch.');
  if (!fillable) throw new Error('Listing is not fillable.');

  // ── Buyer approves USDC and purchases ──
  console.log('\n[3/4] Buyer approves USDC and buys');
  const sellerBefore = await balanceOf(sellerAddress);
  const buyerBefore = await balanceOf(buyerAddress);
  console.log(`    seller USDC before: ${formatUnits(sellerBefore, 6)}`);
  console.log(`    buyer  USDC before: ${formatUnits(buyerBefore, 6)}`);

  await execute({
    walletId: process.env.CIRCLE_COUNTERPARTY_WALLET_ID,
    to: usdcAddress,
    data: encodeFunctionData({
      abi: usdcAbi, functionName: 'approve', args: [marketplaceAddress, priceUnits],
    }),
    label: 'buyer approves USDC',
    scope: 'nft-e2e-approve-usdc',
  });
  await execute({
    walletId: process.env.CIRCLE_COUNTERPARTY_WALLET_ID,
    to: marketplaceAddress,
    data: encodeFunctionData({ abi: marketAbi, functionName: 'buy', args: [tokenId] }),
    label: 'buyer purchases token',
    scope: 'nft-e2e-buy',
  });

  // ── Verify the settled outcome ──
  console.log('\n[4/4] Verify settlement');
  const finalOwner = getAddress(await rpc.readContract({
    address: nftAddress, abi: nftAbi, functionName: 'ownerOf', args: [tokenId],
  }));
  const finalListing = await rpc.readContract({
    address: marketplaceAddress, abi: marketAbi, functionName: 'listings', args: [tokenId],
  });
  const sellerAfter = await balanceOf(sellerAddress);
  const buyerAfter = await balanceOf(buyerAddress);
  const sellerDelta = sellerAfter - sellerBefore;

  console.log(`    new owner:         ${finalOwner}`);
  console.log(`    listing consumed:  ${finalListing[0] === '0x0000000000000000000000000000000000000000'}`);
  console.log(`    seller USDC after: ${formatUnits(sellerAfter, 6)} (delta +${formatUnits(sellerDelta, 6)})`);
  console.log(`    buyer  USDC after: ${formatUnits(buyerAfter, 6)} (delta ${formatUnits(buyerAfter - buyerBefore, 6)})`);

  if (finalOwner !== buyerAddress) throw new Error('NFT did not transfer to the buyer.');
  if (finalListing[0] !== '0x0000000000000000000000000000000000000000') {
    throw new Error('Listing was not consumed.');
  }
  // The seller's delta must be the exact listed price. The buyer also pays Arc gas in USDC, so
  // only the seller side is an exact equality.
  if (sellerDelta !== priceUnits) {
    throw new Error(`Seller delta ${sellerDelta} does not equal listed price ${priceUnits}.`);
  }

  console.log('\nNFT end-to-end verified on Arc Testnet.');
  console.log(`  tokenId:     ${tokenId}`);
  console.log(`  contentHash: ${contentHash}`);
  console.log(`  price:       ${LIST_PRICE_USDC} USDC (seller delta exact)`);
  console.log('\nArc writes performed:');
  for (const write of writes) console.log(`  ${write.label}: ${write.txHash} (block ${write.blockNumber})`);
} catch (error) {
  console.error(`\nNFT end-to-end failed: ${error?.response?.data?.message ?? error.message}`);
  if (writes.length) {
    console.error('Arc writes completed before the failure:');
    for (const write of writes) console.error(`  ${write.label}: ${write.txHash}`);
  }
  process.exitCode = 1;
}

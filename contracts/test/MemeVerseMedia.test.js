import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeFunctionData, keccak256, toHex, zeroAddress } from 'viem';
import { network } from 'hardhat';

const { viem } = await network.create();
const wallets = await viem.getWalletClients();
const [deployer, creator, treasury, buyer, stranger] = wallets;
const USDC = 10n ** 6n;

const CONTENT = toHex('memeverse://media/terminal-frog.png');
const CONTENT_HASH = keccak256(CONTENT);
const METADATA_URI = 'https://memeverse.example/media/1.json';

/** A registered market created by `creator`, plus the media collection bound to that factory. */
async function deployMedia() {
  const currency = await viem.deployContract('MockUSDC');
  const factory = await viem.deployContract('MemeVerseFactory', [
    currency.address,
    treasury.account.address,
    100,
    100,
  ]);
  await factory.write.createMarket(
    ['Terminal Frog', 'FROG', 'A deterministic test market.', 1_000n, 10_000n, 90_000n],
    { account: creator.account },
  );
  const marketAddress = await factory.read.markets([0n]);
  const nft = await viem.deployContract('MemeVerseMediaNFT', [factory.address]);
  const marketplace = await viem.deployContract('MemeVerseNFTMarketplace', [
    nft.address,
    currency.address,
  ]);
  return { currency, factory, marketAddress, nft, marketplace };
}

async function mintTo(context, account = creator, contentHash = CONTENT_HASH) {
  await context.nft.write.mint([context.marketAddress, contentHash, METADATA_URI], {
    account: account.account,
  });
  return context.nft.read.totalMinted();
}

/** Mints, approves the marketplace, and lists at `price`. */
async function listed(price = 5n * USDC) {
  const context = await deployMedia();
  const tokenId = await mintTo(context);
  await context.nft.write.approve([context.marketplace.address, tokenId], {
    account: creator.account,
  });
  await context.marketplace.write.list([tokenId, price], { account: creator.account });
  return { ...context, tokenId, price };
}

async function fundBuyer(currency, marketplace, account = buyer, amount = 100n * USDC) {
  await currency.write.mint([account.account.address, amount]);
  await currency.write.approve([marketplace.address, amount], { account: account.account });
}

// ─────────────────────────────────────────────────────────────────────────────
// MemeVerseMediaNFT — provenance
// ─────────────────────────────────────────────────────────────────────────────

describe('MemeVerseMediaNFT', () => {
  it('lets a registered market creator mint with complete onchain provenance', async () => {
    const context = await deployMedia();
    const tokenId = await mintTo(context);

    assert.equal(tokenId, 1n);
    assert.equal(
      (await context.nft.read.ownerOf([tokenId])).toLowerCase(),
      creator.account.address.toLowerCase(),
    );
    assert.equal(await context.nft.read.tokenURI([tokenId]), METADATA_URI);
    assert.equal(await context.nft.read.tokenIdForContentHash([CONTENT_HASH]), tokenId);

    const provenance = await context.nft.read.provenanceOf([tokenId]);
    assert.equal(provenance.creator.toLowerCase(), creator.account.address.toLowerCase());
    assert.equal(provenance.market.toLowerCase(), context.marketAddress.toLowerCase());
    assert.equal(provenance.contentHash, CONTENT_HASH);
    assert.ok(provenance.mintedAtBlock > 0n);
    assert.ok(provenance.mintedAt > 0n);
    assert.equal((await context.nft.read.factory()).toLowerCase(), context.factory.address.toLowerCase());
  });

  it('refuses to let a non-creator forge association with a real market', async () => {
    const context = await deployMedia();
    await viem.assertions.revertWithCustomError(
      context.nft.write.mint([context.marketAddress, CONTENT_HASH, METADATA_URI], {
        account: stranger.account,
      }),
      context.nft,
      'NotMarketCreator',
    );
    assert.equal(await context.nft.read.totalMinted(), 0n);
  });

  it('rejects a market the trusted factory never registered, even with a valid creator()', async () => {
    const context = await deployMedia();
    // Implements `creator()` and returns the real creator — but is not in the factory registry.
    const spoofed = await viem.deployContract('SpoofedMemeMarket', [creator.account.address]);
    assert.equal(await context.factory.read.isMarket([spoofed.address]), false);

    await viem.assertions.revertWithCustomError(
      context.nft.write.mint([spoofed.address, CONTENT_HASH, METADATA_URI], {
        account: creator.account,
      }),
      context.nft,
      'MarketNotRegistered',
    );
  });

  it('rejects a market from a different factory instance', async () => {
    const context = await deployMedia();
    const currency = await viem.deployContract('MockUSDC');
    const rogueFactory = await viem.deployContract('MemeVerseFactory', [
      currency.address, treasury.account.address, 100, 100,
    ]);
    await rogueFactory.write.createMarket(
      ['Rogue', 'ROGUE', '', 1_000n, 10_000n, 90_000n],
      { account: creator.account },
    );
    const rogueMarket = await rogueFactory.read.markets([0n]);

    await viem.assertions.revertWithCustomError(
      context.nft.write.mint([rogueMarket, CONTENT_HASH, METADATA_URI], {
        account: creator.account,
      }),
      context.nft,
      'MarketNotRegistered',
    );
  });

  it('rejects a zero content hash and an empty metadata URI', async () => {
    const context = await deployMedia();
    await viem.assertions.revertWithCustomError(
      context.nft.write.mint([context.marketAddress, `0x${'00'.repeat(32)}`, METADATA_URI], {
        account: creator.account,
      }),
      context.nft,
      'InvalidContentHash',
    );
    await viem.assertions.revertWithCustomError(
      context.nft.write.mint([context.marketAddress, CONTENT_HASH, ''], {
        account: creator.account,
      }),
      context.nft,
      'InvalidMetadataUri',
    );
  });

  it('rejects a zero factory and never mints the same content twice', async () => {
    const context = await deployMedia();
    await viem.assertions.revertWithCustomError(
      viem.deployContract('MemeVerseMediaNFT', [zeroAddress]),
      context.nft,
      'InvalidConfiguration',
    );

    await mintTo(context);
    await viem.assertions.revertWithCustomError(
      context.nft.write.mint([context.marketAddress, CONTENT_HASH, METADATA_URI], {
        account: creator.account,
      }),
      context.nft,
      'ContentAlreadyMinted',
    );
    assert.equal(await context.nft.read.totalMinted(), 1n);
  });

  it('issues unique sequential token IDs with independent provenance', async () => {
    const context = await deployMedia();
    const second = keccak256(toHex('memeverse://media/second.png'));
    const first = await mintTo(context);
    const next = await mintTo(context, creator, second);

    assert.equal(first, 1n);
    assert.equal(next, 2n);
    assert.equal((await context.nft.read.provenanceOf([2n])).contentHash, second);
    assert.notEqual(
      (await context.nft.read.provenanceOf([1n])).contentHash,
      (await context.nft.read.provenanceOf([2n])).contentHash,
    );
  });

  it('exposes no privileged mint path to the deployer', async () => {
    const context = await deployMedia();
    const abi = context.nft.abi.filter((entry) => entry.type === 'function').map((e) => e.name);
    assert.equal(abi.includes('owner'), false);
    assert.equal(abi.filter((name) => name.toLowerCase().includes('mint') && name !== 'mint' && name !== 'totalMinted').length, 0);

    // The deployer created no market, so the single mint path is closed to them too.
    await viem.assertions.revertWithCustomError(
      context.nft.write.mint([context.marketAddress, CONTENT_HASH, METADATA_URI], {
        account: deployer.account,
      }),
      context.nft,
      'NotMarketCreator',
    );
  });

  it('transfers ownership normally while provenance stays immutable', async () => {
    const context = await deployMedia();
    const tokenId = await mintTo(context);
    const before = await context.nft.read.provenanceOf([tokenId]);

    await context.nft.write.transferFrom(
      [creator.account.address, stranger.account.address, tokenId],
      { account: creator.account },
    );

    assert.equal(
      (await context.nft.read.ownerOf([tokenId])).toLowerCase(),
      stranger.account.address.toLowerCase(),
    );
    const after = await context.nft.read.provenanceOf([tokenId]);
    assert.equal(after.creator, before.creator, 'the minting creator is permanent');
    assert.equal(after.market, before.market);
    assert.equal(after.contentHash, before.contentHash);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MemeVerseNFTMarketplace — USDC settlement
// ─────────────────────────────────────────────────────────────────────────────

describe('MemeVerseNFTMarketplace', () => {
  it('rejects invalid immutable configuration', async () => {
    const context = await deployMedia();
    for (const args of [
      [zeroAddress, context.currency.address],
      [context.nft.address, zeroAddress],
    ]) {
      await viem.assertions.revertWithCustomError(
        viem.deployContract('MemeVerseNFTMarketplace', args),
        context.marketplace,
        'InvalidConfiguration',
      );
    }
    assert.equal((await context.marketplace.read.nft()).toLowerCase(), context.nft.address.toLowerCase());
    assert.equal((await context.marketplace.read.usdc()).toLowerCase(), context.currency.address.toLowerCase());
  });

  it('lists only for the owner, only with approval, and never at zero', async () => {
    const context = await deployMedia();
    const tokenId = await mintTo(context);

    await viem.assertions.revertWithCustomError(
      context.marketplace.write.list([tokenId, 0n], { account: creator.account }),
      context.marketplace,
      'InvalidPrice',
    );
    await viem.assertions.revertWithCustomError(
      context.marketplace.write.list([tokenId, 5n * USDC], { account: stranger.account }),
      context.marketplace,
      'NotTokenOwner',
    );
    // Owner, correct price, but the marketplace was never approved.
    await viem.assertions.revertWithCustomError(
      context.marketplace.write.list([tokenId, 5n * USDC], { account: creator.account }),
      context.marketplace,
      'MarketplaceNotApproved',
    );

    await context.nft.write.approve([context.marketplace.address, tokenId], { account: creator.account });
    await context.marketplace.write.list([tokenId, 5n * USDC], { account: creator.account });
    const listing = await context.marketplace.read.listings([tokenId]);
    assert.equal(listing[0].toLowerCase(), creator.account.address.toLowerCase());
    assert.equal(listing[1], 5n * USDC, 'the listed price is stored exactly');
    assert.equal(await context.marketplace.read.isFillable([tokenId]), true);
  });

  it('cancels only for the seller and makes the listing unfillable', async () => {
    const context = await listed();
    await viem.assertions.revertWithCustomError(
      context.marketplace.write.cancel([context.tokenId], { account: stranger.account }),
      context.marketplace,
      'NotListingSeller',
    );
    await context.marketplace.write.cancel([context.tokenId], { account: creator.account });

    assert.equal((await context.marketplace.read.listings([context.tokenId]))[0], zeroAddress);
    assert.equal(await context.marketplace.read.isFillable([context.tokenId]), false);
    await viem.assertions.revertWithCustomError(
      context.marketplace.write.cancel([context.tokenId], { account: creator.account }),
      context.marketplace,
      'ListingNotFound',
    );
  });

  it('moves the NFT once and exactly the listed USDC once', async () => {
    const context = await listed(7n * USDC);
    await fundBuyer(context.currency, context.marketplace);

    const sellerBefore = await context.currency.read.balanceOf([creator.account.address]);
    const buyerBefore = await context.currency.read.balanceOf([buyer.account.address]);

    await context.marketplace.write.buy([context.tokenId], { account: buyer.account });

    const sellerAfter = await context.currency.read.balanceOf([creator.account.address]);
    const buyerAfter = await context.currency.read.balanceOf([buyer.account.address]);

    assert.equal(sellerAfter - sellerBefore, 7n * USDC, 'seller receives exactly the price');
    assert.equal(buyerBefore - buyerAfter, 7n * USDC, 'buyer pays exactly the price');
    assert.equal(
      (await context.nft.read.ownerOf([context.tokenId])).toLowerCase(),
      buyer.account.address.toLowerCase(),
    );
    // The marketplace is a pure router: it keeps neither the asset nor the money.
    assert.equal(await context.currency.read.balanceOf([context.marketplace.address]), 0n);

    // The listing is consumed exactly once; a replay finds nothing.
    assert.equal((await context.marketplace.read.listings([context.tokenId]))[0], zeroAddress);
    await viem.assertions.revertWithCustomError(
      context.marketplace.write.buy([context.tokenId], { account: buyer.account }),
      context.marketplace,
      'ListingNotFound',
    );
  });

  it('rejects a stale listing after the seller transfers the token away', async () => {
    const context = await listed();
    await fundBuyer(context.currency, context.marketplace);

    await context.nft.write.transferFrom(
      [creator.account.address, stranger.account.address, context.tokenId],
      { account: creator.account },
    );

    assert.equal(await context.marketplace.read.isFillable([context.tokenId]), false);
    await viem.assertions.revertWithCustomError(
      context.marketplace.write.buy([context.tokenId], { account: buyer.account }),
      context.marketplace,
      'SellerNoLongerOwner',
    );
    assert.equal(
      (await context.nft.read.ownerOf([context.tokenId])).toLowerCase(),
      stranger.account.address.toLowerCase(),
    );
  });

  it('rejects a listing whose approval was revoked', async () => {
    const context = await listed();
    await fundBuyer(context.currency, context.marketplace);
    await context.nft.write.approve([zeroAddress, context.tokenId], { account: creator.account });

    assert.equal(await context.marketplace.read.isFillable([context.tokenId]), false);
    await viem.assertions.revertWithCustomError(
      context.marketplace.write.buy([context.tokenId], { account: buyer.account }),
      context.marketplace,
      'MarketplaceNotApproved',
    );
  });

  it('rejects the seller buying their own listing', async () => {
    const context = await listed();
    await fundBuyer(context.currency, context.marketplace, creator);
    await viem.assertions.revertWithCustomError(
      context.marketplace.write.buy([context.tokenId], { account: creator.account }),
      context.marketplace,
      'SellerCannotBuy',
    );
  });

  it('fails atomically on insufficient allowance, balance, and a false-returning USDC', async () => {
    const context = await listed(9n * USDC);

    // No allowance at all.
    await context.currency.write.mint([buyer.account.address, 100n * USDC]);
    await assert.rejects(
      context.marketplace.write.buy([context.tokenId], { account: buyer.account }),
    );

    // Allowance below price.
    await context.currency.write.approve([context.marketplace.address, 1n * USDC], {
      account: buyer.account,
    });
    await assert.rejects(
      context.marketplace.write.buy([context.tokenId], { account: buyer.account }),
    );

    // Sufficient allowance, insufficient balance.
    await context.currency.write.approve([context.marketplace.address, 100n * USDC], {
      account: stranger.account,
    });
    await assert.rejects(
      context.marketplace.write.buy([context.tokenId], { account: stranger.account }),
    );

    // A token that reports failure by returning false rather than reverting.
    await context.currency.write.approve([context.marketplace.address, 100n * USDC], {
      account: buyer.account,
    });
    await context.currency.write.setFailTransfers([true]);
    await assert.rejects(
      context.marketplace.write.buy([context.tokenId], { account: buyer.account }),
    );
    await context.currency.write.setFailTransfers([false]);

    // Through every one of those failures the listing and ownership are untouched.
    assert.equal(
      (await context.nft.read.ownerOf([context.tokenId])).toLowerCase(),
      creator.account.address.toLowerCase(),
    );
    assert.equal((await context.marketplace.read.listings([context.tokenId]))[1], 9n * USDC);

    // And the sale still settles correctly once the token behaves.
    await context.marketplace.write.buy([context.tokenId], { account: buyer.account });
    assert.equal(
      (await context.nft.read.ownerOf([context.tokenId])).toLowerCase(),
      buyer.account.address.toLowerCase(),
    );
  });

  it('rejects a reentrant buyer trying to fill the same listing twice', async () => {
    const context = await listed(3n * USDC);
    const attacker = await viem.deployContract('ReentrantNftBuyer', [context.marketplace.address]);
    await context.currency.write.mint([attacker.address, 100n * USDC]);
    await attacker.write.approveUsdc([context.currency.address, 100n * USDC]);

    await attacker.write.attack([context.tokenId]);

    // The nested call was attempted and refused; exactly one fill occurred.
    assert.equal(await attacker.read.reentryAttempts(), 1n);
    assert.equal(
      (await context.nft.read.ownerOf([context.tokenId])).toLowerCase(),
      attacker.address.toLowerCase(),
    );
    assert.equal(await context.currency.read.balanceOf([attacker.address]), 97n * USDC);
    assert.equal(await context.currency.read.balanceOf([creator.account.address]), 3n * USDC);
    assert.equal((await context.marketplace.read.listings([context.tokenId]))[0], zeroAddress);
  });

  it('rejects reentrancy driven from the USDC transfer callback', async () => {
    const context = await listed(3n * USDC);
    await fundBuyer(context.currency, context.marketplace);

    // The token calls back into the marketplace while the first buy is still executing.
    await context.currency.write.setCallback([
      context.marketplace.address,
      encodeFunctionData({
        abi: context.marketplace.abi,
        functionName: 'buy',
        args: [context.tokenId],
      }),
      true,
    ]);

    await assert.rejects(
      context.marketplace.write.buy([context.tokenId], { account: buyer.account }),
      'a reentrant token callback must abort the whole purchase',
    );

    // Nothing moved.
    assert.equal(
      (await context.nft.read.ownerOf([context.tokenId])).toLowerCase(),
      creator.account.address.toLowerCase(),
    );
    assert.equal(await context.currency.read.balanceOf([creator.account.address]), 0n);
    assert.equal((await context.marketplace.read.listings([context.tokenId]))[1], 3n * USDC);
  });

  it('exposes no withdrawal or administrative surface', async () => {
    const context = await deployMedia();
    const names = context.marketplace.abi
      .filter((entry) => entry.type === 'function')
      .map((entry) => entry.name);
    for (const forbidden of ['withdraw', 'owner', 'transferOwnership', 'rescue', 'sweep', 'setFee']) {
      assert.equal(names.includes(forbidden), false, `${forbidden} must not exist`);
    }
    assert.deepEqual(
      names.sort(),
      ['buy', 'cancel', 'isFillable', 'list', 'listings', 'nft', 'usdc'],
    );
  });

  it('relists after a sale only for the new owner', async () => {
    const context = await listed(2n * USDC);
    await fundBuyer(context.currency, context.marketplace);
    await context.marketplace.write.buy([context.tokenId], { account: buyer.account });

    // The previous owner can no longer list it.
    await viem.assertions.revertWithCustomError(
      context.marketplace.write.list([context.tokenId, 4n * USDC], { account: creator.account }),
      context.marketplace,
      'NotTokenOwner',
    );

    await context.nft.write.approve([context.marketplace.address, context.tokenId], {
      account: buyer.account,
    });
    await context.marketplace.write.list([context.tokenId, 4n * USDC], { account: buyer.account });
    assert.equal((await context.marketplace.read.listings([context.tokenId]))[1], 4n * USDC);
  });
});

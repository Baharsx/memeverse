import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeFunctionData, maxUint256 } from 'viem';
import { network } from 'hardhat';

const { viem } = await network.create();
const wallets = await viem.getWalletClients();
const [deployer, creator, treasury, buyer, secondCreator] = wallets;
const TOKEN = 10n ** 18n;
const USDC = 10n ** 6n;

async function deployFactory({ creatorFeeBps = 100, treasuryFeeBps = 100 } = {}) {
  const currency = await viem.deployContract('MockUSDC');
  const factory = await viem.deployContract('MemeVerseFactory', [
    currency.address,
    treasury.account.address,
    creatorFeeBps,
    treasuryFeeBps,
  ]);
  return { currency, factory };
}

async function createMarket(options = {}) {
  const { currency, factory } = await deployFactory(options);
  const parameters = [
    options.name ?? 'Terminal Frog',
    options.symbol ?? 'FROG',
    options.description ?? 'A deterministic test market.',
    options.supply ?? 1_000n,
    options.basePrice ?? 10_000n,
    options.slopePrice ?? 90_000n,
  ];
  await factory.write.createMarket(parameters, { account: creator.account });
  const marketAddress = await factory.read.markets([0n]);
  const market = await viem.getContractAt('MemeMarket', marketAddress);
  return { currency, factory, market, parameters };
}

async function fundAndApprove(currency, market, amount = 1_000n * USDC) {
  await currency.write.mint([buyer.account.address, amount]);
  await currency.write.approve([market.address, amount], { account: buyer.account });
}

describe('MemeVerseFactory', () => {
  it('creates and registers a market with the caller as creator', async () => {
    const { factory, market, parameters } = await createMarket();
    assert.equal(await factory.read.marketCount(), 1n);
    assert.equal(await factory.read.isMarket([market.address]), true);
    assert.equal((await market.read.creator()).toLowerCase(), creator.account.address.toLowerCase());
    assert.equal((await market.read.treasury()).toLowerCase(), treasury.account.address.toLowerCase());
    assert.equal(await market.read.name(), parameters[0]);
    assert.equal(await market.read.symbol(), parameters[1]);
    assert.equal(await market.read.active(), true);
    assert.ok((await market.read.createdAt()) > 0n);
    assert.ok((await market.read.createdBlock()) > 0n);
  });

  it('rejects invalid immutable configuration and excessive fees', async () => {
    const { currency, factory } = await deployFactory();
    await viem.assertions.revertWithCustomError(
      viem.deployContract('MemeVerseFactory', [
        '0x0000000000000000000000000000000000000000',
        treasury.account.address,
        100,
        100,
      ]),
      factory,
      'InvalidConfiguration',
    );
    await viem.assertions.revertWithCustomError(
      viem.deployContract('MemeVerseFactory', [currency.address, treasury.account.address, 300, 201]),
      factory,
      'InvalidConfiguration',
    );
  });

  it('rejects malformed market parameters', async () => {
    const { factory } = await deployFactory();
    for (const parameters of [
      ['', 'BAD', '', 1_000n, 10_000n, 90_000n],
      ['Name', '', '', 1_000n, 10_000n, 90_000n],
      ['Name', 'BAD', '', 99n, 10_000n, 90_000n],
      ['Name', 'BAD', '', 1_000n, 0n, 90_000n],
      ['Name', 'BAD', 'x'.repeat(281), 1_000n, 10_000n, 90_000n],
    ]) {
      await viem.assertions.revertWithCustomError(
        factory.write.createMarket(parameters, { account: creator.account }),
        factory,
        'InvalidMarketParameters',
      );
    }
  });

  it('prevents duplicate creator-symbol markets but permits another creator', async () => {
    const { factory } = await createMarket();
    const parameters = ['Another Frog', 'FROG', '', 1_000n, 10_000n, 90_000n];
    await viem.assertions.revertWithCustomError(
      factory.write.createMarket(parameters, { account: creator.account }),
      factory,
      'DuplicateMarket',
    );
    await factory.write.createMarket(parameters, { account: secondCreator.account });
    assert.equal(await factory.read.marketCount(), 2n);
  });
});

describe('MemeMarket', () => {
  it('starts with the complete fixed supply in market inventory', async () => {
    const { market } = await createMarket();
    assert.equal(await market.read.totalSupply(), 1_000n * TOKEN);
    assert.equal(await market.read.balanceOf([market.address]), 1_000n * TOKEN);
    assert.equal(await market.read.soldTokenCount(), 0n);
    assert.equal(await market.read.reserveUsdc(), 0n);
    assert.equal(await market.read.spotPriceUsdc(), 10_000n);
  });

  it('returns a deterministic maximal buy quote with explicit fee rounding', async () => {
    const { market } = await createMarket();
    const maximumUsdcIn = 1n * USDC;
    const [tokenOut, curveCost, creatorFee, treasuryFee, actualUsdcSpent] =
      await market.read.quoteBuy([maximumUsdcIn]);
    assert.equal(creatorFee, curveCost / 100n);
    assert.equal(treasuryFee, curveCost / 100n);
    assert.equal(actualUsdcSpent, curveCost + creatorFee + treasuryFee);
    assert.ok(actualUsdcSpent <= maximumUsdcIn);
    assert.equal(tokenOut % TOKEN, 0n);
    assert.ok(tokenOut > 0n);
    const tokenCount = tokenOut / TOKEN;
    const nextCost = await market.read.cumulativeCurveCost([tokenCount + 1n]);
    const nextSpend = nextCost + nextCost / 100n + nextCost / 100n;
    assert.ok(nextSpend > maximumUsdcIn);
    assert.deepEqual(
      await market.read.quoteBuy([maximumUsdcIn]),
      [tokenOut, curveCost, creatorFee, treasuryFee, actualUsdcSpent],
    );
  });

  it('executes a buy and accounts for reserve, creator, treasury, and supply', async () => {
    const { currency, market } = await createMarket();
    const maximumUsdcIn = 1n * USDC;
    await fundAndApprove(currency, market, maximumUsdcIn);
    const quote = await market.read.quoteBuy([maximumUsdcIn]);
    await market.write.buy([maximumUsdcIn, quote[0]], { account: buyer.account });

    assert.equal(await market.read.balanceOf([buyer.account.address]), quote[0]);
    assert.equal(await market.read.soldTokenCount(), quote[0] / TOKEN);
    assert.equal(await market.read.reserveUsdc(), quote[1]);
    assert.equal(await market.read.creatorFeesPaidUsdc(), quote[2]);
    assert.equal(await market.read.treasuryFeesPaidUsdc(), quote[3]);
    assert.equal(await currency.read.balanceOf([buyer.account.address]), maximumUsdcIn - quote[4]);
    assert.equal(await currency.read.allowance([buyer.account.address, market.address]), maximumUsdcIn - quote[4]);
    assert.equal(await currency.read.balanceOf([creator.account.address]), quote[2]);
    assert.equal(await currency.read.balanceOf([treasury.account.address]), quote[3]);
    assert.equal(await currency.read.balanceOf([market.address]), quote[1]);
    assert.equal(
      (await market.read.balanceOf([market.address])) + (await market.read.soldTokenCount()) * TOKEN,
      await market.read.totalSupply(),
    );
  });

  it('does not overcharge an oversized maximum and retains every unused unit in the wallet', async () => {
    const { currency, market } = await createMarket({ supply: 100n });
    const maximumUsdcIn = 1_000n * USDC;
    await fundAndApprove(currency, market, maximumUsdcIn);
    const quote = await market.read.quoteBuy([maximumUsdcIn]);
    assert.equal(quote[0], 100n * TOKEN);
    assert.ok(quote[4] < maximumUsdcIn / 100n);

    await market.write.buy([maximumUsdcIn, quote[0]], { account: buyer.account });

    assert.equal(await currency.read.balanceOf([buyer.account.address]), maximumUsdcIn - quote[4]);
    assert.equal(await currency.read.allowance([buyer.account.address, market.address]), maximumUsdcIn - quote[4]);
    assert.equal(await currency.read.balanceOf([market.address]), quote[1]);
    assert.equal(quote[2], (quote[1] * 100n) / 10_000n);
    assert.equal(quote[3], (quote[1] * 100n) / 10_000n);
    assert.equal(quote[4], quote[1] + quote[2] + quote[3]);
  });

  it('charges only the exact executed value when buying the entire remaining supply', async () => {
    const { currency, market } = await createMarket({ supply: 100n });
    const walletFunding = 2_000n * USDC;
    await fundAndApprove(currency, market, walletFunding);
    const firstQuote = await market.read.quoteBuy([1n * USDC]);
    await market.write.buy([1n * USDC, firstQuote[0]], { account: buyer.account });
    const soldBefore = await market.read.soldTokenCount();
    const startCost = await market.read.cumulativeCurveCost([soldBefore]);
    const finalCost = await market.read.cumulativeCurveCost([100n]);
    const expectedCurveCost = finalCost - startCost;
    const expectedCreatorFee = expectedCurveCost / 100n;
    const expectedTreasuryFee = expectedCurveCost / 100n;
    const oversizedMaximum = 1_000n * USDC;

    const quote = await market.read.quoteBuy([oversizedMaximum]);
    assert.equal(quote[0], (100n - soldBefore) * TOKEN);
    assert.deepEqual(
      quote.slice(1),
      [
        expectedCurveCost,
        expectedCreatorFee,
        expectedTreasuryFee,
        expectedCurveCost + expectedCreatorFee + expectedTreasuryFee,
      ],
    );
    const buyerBefore = await currency.read.balanceOf([buyer.account.address]);
    await market.write.buy([oversizedMaximum, quote[0]], { account: buyer.account });
    assert.equal(await currency.read.balanceOf([buyer.account.address]), buyerBefore - quote[4]);
    assert.equal(await market.read.soldTokenCount(), 100n);
    assert.equal(await currency.read.balanceOf([market.address]), await market.read.reserveUsdc());
  });

  it('bounds fee rounding below one USDC atomic unit per allocation and keeps curve reversal exact', async () => {
    const { currency, market } = await createMarket({
      supply: 100n,
      basePrice: 101n,
      slopePrice: 997n,
      creatorFeeBps: 333,
      treasuryFeeBps: 167,
    });
    const maximumUsdcIn = 25_000n;
    await fundAndApprove(currency, market, maximumUsdcIn);
    const quote = await market.read.quoteBuy([maximumUsdcIn]);
    assert.ok(quote[0] > 0n);
    assert.ok(quote[4] <= maximumUsdcIn);
    assert.ok(quote[1] * 333n - quote[2] * 10_000n < 10_000n);
    assert.ok(quote[1] * 167n - quote[3] * 10_000n < 10_000n);
    await market.write.buy([maximumUsdcIn, quote[0]], { account: buyer.account });
    const sellQuote = await market.read.quoteSell([quote[0]]);
    assert.equal(sellQuote[1], quote[1]);
    assert.equal(await currency.read.balanceOf([market.address]), quote[1]);
  });

  it('executes a buy-sell round trip and preserves reserve solvency', async () => {
    const { currency, market } = await createMarket();
    await fundAndApprove(currency, market, 10n * USDC);
    const buyQuote = await market.read.quoteBuy([10n * USDC]);
    await market.write.buy([10n * USDC, buyQuote[0]], { account: buyer.account });
    const tokenIn = (buyQuote[0] / TOKEN / 2n) * TOKEN;
    const sellQuote = await market.read.quoteSell([tokenIn]);
    const buyerBefore = await currency.read.balanceOf([buyer.account.address]);
    const creatorBefore = await currency.read.balanceOf([creator.account.address]);
    const treasuryBefore = await currency.read.balanceOf([treasury.account.address]);
    const reserveBefore = await market.read.reserveUsdc();

    await market.write.sell([tokenIn, sellQuote[0]], { account: buyer.account });
    assert.equal(await currency.read.balanceOf([buyer.account.address]), buyerBefore + sellQuote[0]);
    assert.equal(await currency.read.balanceOf([creator.account.address]), creatorBefore + sellQuote[2]);
    assert.equal(await currency.read.balanceOf([treasury.account.address]), treasuryBefore + sellQuote[3]);
    assert.equal(await market.read.reserveUsdc(), reserveBefore - sellQuote[1]);
    assert.ok((await currency.read.balanceOf([market.address])) >= (await market.read.reserveUsdc()));
    assert.equal(
      (await market.read.balanceOf([market.address])) + (await market.read.soldTokenCount()) * TOKEN,
      await market.read.totalSupply(),
    );
  });

  it('rejects zero input, fractional sells, and excessive slippage', async () => {
    const { currency, market } = await createMarket();
    await fundAndApprove(currency, market, USDC);
    const quote = await market.read.quoteBuy([USDC]);
    await viem.assertions.revertWithCustomError(
      market.write.buy([0n, 0n], { account: buyer.account }), market, 'InvalidAmount',
    );
    await viem.assertions.revertWithCustomError(
      market.write.buy([USDC, quote[0] + TOKEN], { account: buyer.account }), market, 'SlippageExceeded',
    );
    await market.write.buy([USDC, quote[0]], { account: buyer.account });
    await viem.assertions.revertWithCustomError(
      market.write.sell([TOKEN + 1n, 0n], { account: buyer.account }), market, 'AmountMustBeWholeTokens',
    );
    const sellQuote = await market.read.quoteSell([TOKEN]);
    await viem.assertions.revertWithCustomError(
      market.write.sell([TOKEN, sellQuote[0] + 1n], { account: buyer.account }), market, 'SlippageExceeded',
    );
  });

  it('fails closed for insufficient USDC allowance and balance', async () => {
    const { currency, market } = await createMarket();
    await currency.write.mint([buyer.account.address, USDC]);
    await viem.assertions.revertWithCustomError(
      market.write.buy([USDC, 1n], { account: buyer.account }), market, 'TransferFailed',
    );
    await currency.write.approve([market.address, maxUint256], { account: buyer.account });
    await viem.assertions.revertWithCustomError(
      market.write.buy([2n * USDC, 1n], { account: buyer.account }), market, 'TransferFailed',
    );
  });

  it('handles the maximum supply edge and rejects purchases after sellout', async () => {
    const { currency, market } = await createMarket({ supply: 1_000_000_000n });
    const hugeInput = 2_000_000_000n * USDC;
    await fundAndApprove(currency, market, hugeInput);
    const quote = await market.read.quoteBuy([hugeInput]);
    assert.equal(quote[0], 1_000_000_000n * TOKEN);
    await market.write.buy([hugeInput, quote[0]], { account: buyer.account });
    assert.equal(await market.read.spotPriceUsdc(), 0n);
    await viem.assertions.revertWithCustomError(
      market.write.buy([USDC, 0n], { account: buyer.account }), market, 'InvalidAmount',
    );
  });

  it('blocks direct transfers into market inventory and exposes no withdrawal surface', async () => {
    const { currency, market } = await createMarket();
    await fundAndApprove(currency, market, USDC);
    const quote = await market.read.quoteBuy([USDC]);
    await market.write.buy([USDC, quote[0]], { account: buyer.account });
    await viem.assertions.revertWithCustomError(
      market.write.transfer([market.address, TOKEN], { account: buyer.account }), market, 'InvalidRecipient',
    );
    assert.equal(market.abi.some((item) => item.type === 'function' && /withdraw/i.test(item.name)), false);
  });

  it('reverts atomically when USDC returns false', async () => {
    const { currency, market } = await createMarket();
    await fundAndApprove(currency, market, USDC);
    await currency.write.setFailTransfers([true]);
    await viem.assertions.revertWithCustomError(
      market.write.buy([USDC, 1n], { account: buyer.account }), market, 'TransferFailed',
    );
    assert.equal(await market.read.soldTokenCount(), 0n);
    assert.equal(await market.read.reserveUsdc(), 0n);
  });

  it('rejects an ERC-20 callback reentrancy attempt without changing state', async () => {
    const { currency, market } = await createMarket();
    await fundAndApprove(currency, market, USDC);
    const callback = encodeFunctionData({ abi: market.abi, functionName: 'buy', args: [1n, 0n] });
    await currency.write.setCallback([market.address, callback, true]);
    await viem.assertions.revertWithCustomError(
      market.write.buy([USDC, 1n], { account: buyer.account }), market, 'TransferFailed',
    );
    assert.equal(await market.read.soldTokenCount(), 0n);
    assert.equal(await currency.read.balanceOf([buyer.account.address]), USDC);
  });
});

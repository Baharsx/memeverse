import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeFunctionData, maxUint256 } from 'viem';
import { network } from 'hardhat';

const { viem } = await network.create();
const [deployer, creator, treasury, buyer, friend] = await viem.getWalletClients();
const TOKEN = 10n ** 18n;
const USDC = 10n ** 6n;

async function fixture(options = {}) {
  const currency = await viem.deployContract('MockUSDC');
  const factory = await viem.deployContract('MemeVerseFractionalFactory', [currency.address, treasury.account.address, options.creatorFee ?? 100, options.treasuryFee ?? 100]);
  const args = ['Fractional Meme', 'FRAC', 'Fractional trading fixture', options.supply ?? 1000000n, options.base ?? USDC, options.slope ?? 1000n];
  await factory.write.createMarket(args, { account: creator.account });
  const market = await viem.getContractAt('MemeFractionalMarket', await factory.read.markets([0n]));
  await currency.write.mint([buyer.account.address, options.funding ?? 1000n * USDC]);
  await currency.write.approve([market.address, maxUint256], { account: buyer.account });
  return { currency, factory, market, args };
}
async function backed({ currency, market }) {
  const sold = await market.read.soldTokenUnits();
  const reserve = await market.read.reserveUsdc();
  assert.equal(reserve, await market.read.cumulativeCurveCost([sold]));
  assert.equal(await currency.read.balanceOf([market.address]), reserve);
  assert.equal(await market.read.balanceOf([market.address]) + sold, await market.read.totalSupply());
}
async function buy(app, amount) {
  const quote = await app.market.read.quoteBuy([amount]);
  await app.market.write.buy([amount, quote[0]], { account: buyer.account });
  await backed(app);
  return quote;
}

describe('MemeVerse fractional markets', () => {
  it('creates a separate versioned registry without changing legacy contracts', async () => {
    const { factory, market, currency } = await fixture();
    assert.equal(await factory.read.tradingVersion(), 2n);
    assert.equal(await market.read.tradingVersion(), 2n);
    assert.equal(await factory.read.isMarket([market.address]), true);
    assert.equal(await market.read.totalSupply(), 1000000n * TOKEN);
    const legacy = await viem.deployContract('MemeVerseFactory', [currency.address, treasury.account.address, 100, 100]);
    assert.equal(await legacy.read.isMarket([market.address]), false);
    await viem.assertions.revertWithCustomError(factory.write.createMarket(['Again', 'FRAC', '', 100n, USDC, 1000n], { account: creator.account }), factory, 'DuplicateMarket');
  });
  it('quotes real fractions for one and two dollars at a one-dollar starting price', async () => {
    const app = await fixture();
    const one = await app.market.read.quoteBuy([USDC]);
    const two = await app.market.read.quoteBuy([2n * USDC]);
    assert.ok(one[0] > 980000000000000000n && one[0] < 981000000000000000n);
    assert.ok(two[0] > 1960000000000000000n && two[0] < 1962000000000000000n);
    assert.ok(one[0] % TOKEN !== 0n && two[0] % TOKEN !== 0n);
    assert.ok(one[4] <= USDC && two[4] <= 2n * USDC);
    assert.equal(one[4], one[1] + one[2] + one[3]);
    const paid = await buy(app, USDC);
    assert.equal(await app.market.read.balanceOf([buyer.account.address]), paid[0]);
    assert.equal(await app.market.read.soldTokenUnits(), paid[0]);
    assert.equal(await app.market.read.soldTokenCount(), 0n);
  });
  it('returns the greatest affordable fractional amount at USDC precision', async () => {
    const app = await fixture({ base: 101n, slope: 997n, supply: 100n, creatorFee: 333, treasuryFee: 167 });
    for (const budget of [1n, 99n, 10000n, 25000n]) {
      const quote = await app.market.read.quoteBuy([budget]);
      assert.ok(quote[0] > 0n && quote[4] <= budget);
      const nextCost = await app.market.read.cumulativeCurveCost([quote[0] + 1n]);
      const nextSpend = nextCost + nextCost * 333n / 10000n + nextCost * 167n / 10000n;
      assert.ok(nextSpend > budget, 'the next atomic token unit must exceed the budget');
    }
  });
  it('sells arbitrary fractions and can completely unwind a fractional purchase', async () => {
    const app = await fixture();
    const bought = await buy(app, 2n * USDC);
    const fraction = 123456789012345678n;
    const quote = await app.market.read.quoteSell([fraction]);
    assert.ok(quote[0] > 0n);
    const before = await app.currency.read.balanceOf([buyer.account.address]);
    await app.market.write.sell([fraction, quote[0]], { account: buyer.account });
    assert.equal(await app.currency.read.balanceOf([buyer.account.address]), before + quote[0]);
    await backed(app);
    const remaining = bought[0] - fraction;
    const rest = await app.market.read.quoteSell([remaining]);
    await app.market.write.sell([remaining, rest[0]], { account: buyer.account });
    assert.equal(await app.market.read.soldTokenUnits(), 0n);
    assert.equal(await app.market.read.reserveUsdc(), 0n);
    await backed(app);
  });
  it('keeps reserves and circulating balances exact across many fractional trades', async () => {
    const app = await fixture({ base: 101n, slope: 900000n, supply: 1000n });
    let seed = 19n;
    for (let i = 0; i < 32; i++) {
      seed = (seed * 1103515245n + 12345n) % (2n ** 31n);
      if (i % 3 !== 2) await buy(app, 10000n + seed % 1000000n);
      else {
        const balance = await app.market.read.balanceOf([buyer.account.address]);
        const amount = balance / (2n + seed % 5n);
        const quote = await app.market.read.quoteSell([amount]);
        if (quote[0] > 0n) await app.market.write.sell([amount, quote[0]], { account: buyer.account });
        await backed(app);
      }
    }
    const remaining = await app.market.read.balanceOf([buyer.account.address]);
    const quote = await app.market.read.quoteSell([remaining]);
    await app.market.write.sell([remaining, quote[0]], { account: buyer.account });
    await backed(app);
    assert.equal(await app.market.read.reserveUsdc(), 0n);
  });
  it('preserves solvency at maximum supply and maximum curve prices', async () => {
    const app = await fixture({ supply: 1000000000n, base: 1000000000n, slope: 1000000000n, funding: 2n * 10n ** 18n });
    const quote = await buy(app, 2n * 10n ** 18n);
    assert.equal(quote[0], 1000000000n * TOKEN);
    assert.equal(await app.market.read.spotPriceUsdc(), 0n);
    assert.deepEqual(await app.market.read.quoteBuy([USDC]), [0n, 0n, 0n, 0n, 0n]);
    const sell = await app.market.read.quoteSell([quote[0]]);
    await app.market.write.sell([quote[0], sell[0]], { account: buyer.account });
    await backed(app);
  });
  it('rejects zero value and zero-return dust without giving away tokens', async () => {
    const app = await fixture();
    assert.deepEqual(await app.market.read.quoteBuy([0n]), [0n, 0n, 0n, 0n, 0n]);
    await viem.assertions.revertWithCustomError(app.market.write.buy([0n, 0n], { account: buyer.account }), app.market, 'InvalidAmount');
    await buy(app, USDC);
    assert.equal((await app.market.read.quoteSell([1n]))[0], 0n);
    await viem.assertions.revertWithCustomError(app.market.write.sell([1n, 0n], { account: buyer.account }), app.market, 'InvalidAmount');
    await backed(app);
  });
  it('enforces minimum output for both fractional directions', async () => {
    const app = await fixture();
    const quote = await app.market.read.quoteBuy([USDC]);
    await viem.assertions.revertWithCustomError(app.market.write.buy([USDC, quote[0] + 1n], { account: buyer.account }), app.market, 'SlippageExceeded');
    await buy(app, USDC);
    const amount = quote[0] / 3n;
    const sell = await app.market.read.quoteSell([amount]);
    await viem.assertions.revertWithCustomError(app.market.write.sell([amount, sell[0] + 1n], { account: buyer.account }), app.market, 'SlippageExceeded');
    await backed(app);
  });
  it('allows fractional transfers, authenticates balances and blocks inventory donations', async () => {
    const app = await fixture();
    await buy(app, USDC);
    const fraction = 123456789012345678n;
    await app.market.write.transfer([friend.account.address, fraction], { account: buyer.account });
    assert.equal(await app.market.read.balanceOf([friend.account.address]), fraction);
    const quote = await app.market.read.quoteSell([fraction]);
    await app.market.write.sell([fraction, quote[0]], { account: friend.account });
    await viem.assertions.revertWithCustomError(app.market.write.transfer([app.market.address, 1n], { account: buyer.account }), app.market, 'InvalidRecipient');
    await viem.assertions.revertWithCustomError(app.market.write.sell([fraction, 0n], { account: friend.account }), app.market, 'InsufficientBalance');
    await backed(app);
  });
  it('reverts atomically on token failures and callback reentrancy', async () => {
    const app = await fixture();
    await app.currency.write.setFailTransfers([true]);
    await viem.assertions.revertWithCustomError(app.market.write.buy([USDC, 1n], { account: buyer.account }), app.market, 'TransferFailed');
    await app.currency.write.setFailTransfers([false]);
    const callback = encodeFunctionData({ abi: app.market.abi, functionName: 'buy', args: [1n, 0n] });
    await app.currency.write.setCallback([app.market.address, callback, true]);
    await viem.assertions.revertWithCustomError(app.market.write.buy([USDC, 1n], { account: buyer.account }), app.market, 'TransferFailed');
    assert.equal(await app.market.read.soldTokenUnits(), 0n);
    await backed(app);
  });
  it('protects currency and fee bounds and contains no reserve withdrawal mechanism', async () => {
    const { factory, market } = await fixture();
    await viem.assertions.revertWithCustomError(factory.write.createMarket(['Bad', 'BAD', '', 1000000001n, USDC, 1000n]), factory, 'InvalidMarketParameters');
    assert.equal(market.abi.some(item => item.type === 'function' && /withdraw|upgrade|mint/i.test(item.name)), false);
    const quote = await market.read.quoteBuy([USDC]);
    const publicClient = await viem.getPublicClient();
    const gas = await publicClient.estimateContractGas({ address: market.address, abi: market.abi, functionName: 'buy', args: [USDC, quote[0]], account: buyer.account });
    assert.ok(gas < 1000000n, `fractional buy gas should be bounded, got ${gas}`);
  });
});

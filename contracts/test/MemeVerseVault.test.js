import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeFunctionData, maxUint256, zeroAddress } from 'viem';
import { network } from 'hardhat';

const { viem } = await network.create();
const wallets = await viem.getWalletClients();
const [deployer, alice, bob, attacker] = wallets;
const USDC = 10n ** 6n;

async function deployVault() {
  const currency = await viem.deployContract('MockUSDC');
  const vault = await viem.deployContract('MemeVerseVault', [currency.address]);
  return { currency, vault };
}

async function fund(currency, vault, account, amount) {
  await currency.write.mint([account.account.address, amount]);
  await currency.write.approve([vault.address, amount], { account: account.account });
}

/** The solvency invariant: real USDC held must cover everything the accounting owes. */
async function assertSolvent(context, note = '') {
  const held = await context.currency.read.balanceOf([context.vault.address]);
  const totalAssets = await context.vault.read.totalAssets();
  const supply = await context.vault.read.totalSupply();
  assert.equal(totalAssets, held, `totalAssets must be the real balance ${note}`);
  const owed = supply === 0n ? 0n : await context.vault.read.previewRedeem([supply]);
  assert.ok(owed <= held, `vault owes ${owed} but holds ${held} ${note}`);
}

describe('MemeVerseVault', () => {
  it('starts empty, targets Arc USDC, and advertises no yield', async () => {
    const { currency, vault } = await deployVault();
    assert.equal((await vault.read.asset()).toLowerCase(), currency.address.toLowerCase());
    assert.equal(await vault.read.totalAssets(), 0n);
    assert.equal(await vault.read.totalSupply(), 0n);
    assert.equal(await vault.read.name(), 'MemeVerse Vault USDC');
    assert.equal(await vault.read.symbol(), 'mvUSDC');
    // Six-decimal asset plus the six-decimal virtual offset.
    assert.equal(await vault.read.decimals(), 12);
    assert.equal(await vault.read.annualPercentageYieldBps(), 0n, 'no invented yield');
  });

  it('refuses a zero asset and a non-six-decimal asset', async () => {
    const { vault } = await deployVault();
    await viem.assertions.revertWithCustomError(
      viem.deployContract('MemeVerseVault', [zeroAddress]),
      vault,
      'InvalidConfiguration',
    );
    // An 18-decimal token is not the Arc USDC interface this vault accounts in.
    const wrongDecimals = await viem.deployContract('MemeMarket', [
      alice.account.address, bob.account.address, zeroAddress,
      'Wrong', 'WRONG', '', 1_000n, 10_000n, 90_000n, 100, 100,
    ]);
    await viem.assertions.revertWithCustomError(
      viem.deployContract('MemeVerseVault', [wrongDecimals.address]),
      vault,
      'InvalidConfiguration',
    );
  });

  it('records a real position for a deposit and redeems it whole', async () => {
    const context = await deployVault();
    const { currency, vault } = context;
    await fund(currency, vault, alice, 100n * USDC);

    const expected = await vault.read.previewDeposit([25n * USDC]);
    await vault.write.deposit([25n * USDC, alice.account.address], { account: alice.account });
    const shares = await vault.read.balanceOf([alice.account.address]);

    assert.equal(shares, expected, 'preview matches the executed deposit');
    assert.equal(await vault.read.totalAssets(), 25n * USDC, 'real USDC custody');
    assert.equal(await currency.read.balanceOf([vault.address]), 25n * USDC);
    assert.equal(await vault.read.maxWithdraw([alice.account.address]), 25n * USDC);
    await assertSolvent(context, 'after deposit');

    await vault.write.redeem([shares, alice.account.address, alice.account.address], {
      account: alice.account,
    });
    assert.equal(await vault.read.balanceOf([alice.account.address]), 0n);
    assert.equal(await currency.read.balanceOf([alice.account.address]), 100n * USDC);
    assert.equal(await vault.read.totalAssets(), 0n);
    await assertSolvent(context, 'after full redeem');
  });

  it('keeps two depositors' + ' positions independent and proportional', async () => {
    const context = await deployVault();
    const { currency, vault } = context;
    await fund(currency, vault, alice, 100n * USDC);
    await fund(currency, vault, bob, 100n * USDC);

    await vault.write.deposit([30n * USDC, alice.account.address], { account: alice.account });
    await vault.write.deposit([60n * USDC, bob.account.address], { account: bob.account });

    const aliceShares = await vault.read.balanceOf([alice.account.address]);
    const bobShares = await vault.read.balanceOf([bob.account.address]);
    assert.equal(bobShares, aliceShares * 2n, 'twice the deposit is twice the position');
    assert.equal(await vault.read.totalAssets(), 90n * USDC);
    await assertSolvent(context, 'two depositors');

    // A partial withdrawal never touches the other depositor.
    await vault.write.withdraw([10n * USDC, alice.account.address, alice.account.address], {
      account: alice.account,
    });
    assert.equal(await vault.read.maxWithdraw([bob.account.address]), 60n * USDC);
    assert.equal(await vault.read.maxWithdraw([alice.account.address]), 20n * USDC);
    await assertSolvent(context, 'after partial withdraw');
  });

  it('supports multiple sequential deposits from one wallet', async () => {
    const context = await deployVault();
    const { currency, vault } = context;
    await fund(currency, vault, alice, 100n * USDC);

    for (const amount of [1n * USDC, 5n * USDC, 20n * USDC]) {
      await vault.write.deposit([amount, alice.account.address], { account: alice.account });
      await assertSolvent(context, `after depositing ${amount}`);
    }
    assert.equal(await vault.read.totalAssets(), 26n * USDC);
    assert.equal(await vault.read.maxWithdraw([alice.account.address]), 26n * USDC);
  });

  it('rejects zero amounts on every entry point', async () => {
    const context = await deployVault();
    const { currency, vault } = context;
    await fund(currency, vault, alice, 10n * USDC);
    await vault.write.deposit([5n * USDC, alice.account.address], { account: alice.account });

    // Built lazily: eagerly constructing every call would fire all four at once and leave the
    // not-yet-awaited rejections unhandled.
    for (const call of [
      () => vault.write.deposit([0n, alice.account.address], { account: alice.account }),
      () => vault.write.mint([0n, alice.account.address], { account: alice.account }),
      () => vault.write.withdraw([0n, alice.account.address, alice.account.address], { account: alice.account }),
      () => vault.write.redeem([0n, alice.account.address, alice.account.address], { account: alice.account }),
    ]) {
      await viem.assertions.revertWithCustomError(call(), vault, 'ZeroAmount');
    }
  });

  it('handles the one-atomic-unit boundary exactly', async () => {
    const context = await deployVault();
    const { currency, vault } = context;
    await fund(currency, vault, alice, 10n * USDC);

    await vault.write.deposit([1n, alice.account.address], { account: alice.account });
    assert.equal(await vault.read.totalAssets(), 1n);
    assert.equal(await vault.read.balanceOf([alice.account.address]), 1_000_000n, 'offset-scaled shares');
    await assertSolvent(context, 'one atomic unit');

    await vault.write.redeem([1_000_000n, alice.account.address, alice.account.address], {
      account: alice.account,
    });
    assert.equal(await currency.read.balanceOf([alice.account.address]), 10n * USDC);
    await assertSolvent(context, 'after one-unit redeem');
  });

  it('rejects redeeming more shares than are owned', async () => {
    const context = await deployVault();
    const { currency, vault } = context;
    await fund(currency, vault, alice, 10n * USDC);
    await vault.write.deposit([5n * USDC, alice.account.address], { account: alice.account });
    const shares = await vault.read.balanceOf([alice.account.address]);

    await assert.rejects(
      vault.write.redeem([shares + 1n, alice.account.address, alice.account.address], {
        account: alice.account,
      }),
    );
    await assert.rejects(
      vault.write.withdraw([6n * USDC, alice.account.address, alice.account.address], {
        account: alice.account,
      }),
    );
    await assertSolvent(context, 'after failed over-redemption');
  });

  it('requires share allowance for a third party to redeem on an owner behalf', async () => {
    const context = await deployVault();
    const { currency, vault } = context;
    await fund(currency, vault, alice, 10n * USDC);
    await vault.write.deposit([5n * USDC, alice.account.address], { account: alice.account });
    const shares = await vault.read.balanceOf([alice.account.address]);

    // Without an allowance a third party cannot move someone else's position.
    await assert.rejects(
      vault.write.redeem([shares, bob.account.address, alice.account.address], { account: bob.account }),
    );

    await vault.write.approve([bob.account.address, shares], { account: alice.account });
    await vault.write.redeem([shares, bob.account.address, alice.account.address], {
      account: bob.account,
    });
    assert.equal(await currency.read.balanceOf([bob.account.address]), 5n * USDC);
    assert.equal(await vault.read.allowance([alice.account.address, bob.account.address]), 0n);
    await assertSolvent(context, 'after delegated redeem');
  });

  it('absorbs a first-depositor donation instead of stealing the next depositor', async () => {
    const context = await deployVault();
    const { currency, vault } = context;
    await fund(currency, vault, attacker, 100_000n * USDC);
    await fund(currency, vault, alice, 10_000n * USDC);

    // The classic inflation setup: mint the smallest possible position, then donate a fortune
    // straight to the vault to distort the share price before the victim arrives.
    await vault.write.deposit([1n, attacker.account.address], { account: attacker.account });
    await currency.write.transfer([vault.address, 10_000n * USDC], { account: attacker.account });

    const victimDeposit = 1_000n * USDC;
    await vault.write.deposit([victimDeposit, alice.account.address], { account: alice.account });
    const victimShares = await vault.read.balanceOf([alice.account.address]);
    assert.ok(victimShares > 0n, 'the victim must never be rounded down to zero shares');

    const recoverable = await vault.read.previewRedeem([victimShares]);
    // The virtual offset caps the attacker's extractable value; the victim keeps essentially all
    // of their principal rather than losing it to the donation.
    // The residual rounding loss must stay under one basis point of the deposit. At a 10**3
    // offset this same donation cost the victim ~0.45%; at 10**6 it costs ~0.00045%.
    const loss = victimDeposit - recoverable;
    assert.ok(
      loss * 10_000n <= victimDeposit,
      `victim lost ${loss} of ${victimDeposit}, above one basis point`,
    );

    await vault.write.redeem([victimShares, alice.account.address, alice.account.address], {
      account: alice.account,
    });
    const attackerShares = await vault.read.balanceOf([attacker.account.address]);
    const attackerRecovers = await vault.read.previewRedeem([attackerShares]);
    assert.ok(
      attackerRecovers <= 10_000n * USDC + 1n,
      'the attacker cannot extract more than they donated',
    );
    await assertSolvent(context, 'after donation attack');
  });

  it('treats a plain donation as shared yield without breaking solvency', async () => {
    const context = await deployVault();
    const { currency, vault } = context;
    await fund(currency, vault, alice, 100n * USDC);
    await fund(currency, vault, bob, 100n * USDC);

    await vault.write.deposit([50n * USDC, alice.account.address], { account: alice.account });
    await currency.write.transfer([vault.address, 10n * USDC], { account: bob.account });

    assert.equal(await vault.read.totalAssets(), 60n * USDC, 'donations are real assets');
    await assertSolvent(context, 'after donation');

    const shares = await vault.read.balanceOf([alice.account.address]);
    await vault.write.redeem([shares, alice.account.address, alice.account.address], {
      account: alice.account,
    });
    // The sole depositor receives the donation too; nothing is stranded or double-counted.
    assert.ok(await currency.read.balanceOf([alice.account.address]) > 100n * USDC);
    await assertSolvent(context, 'after redeeming donated yield');
  });

  it('reverts atomically when the asset returns false', async () => {
    const context = await deployVault();
    const { currency, vault } = context;
    await fund(currency, vault, alice, 100n * USDC);
    await currency.write.setFailTransfers([true]);

    await assert.rejects(
      vault.write.deposit([10n * USDC, alice.account.address], { account: alice.account }),
    );
    assert.equal(await vault.read.totalSupply(), 0n, 'no shares are minted without payment');
    assert.equal(await vault.read.totalAssets(), 0n);

    await currency.write.setFailTransfers([false]);
    await vault.write.deposit([10n * USDC, alice.account.address], { account: alice.account });
    await assertSolvent(context, 'after recovering from a false-returning token');
  });

  it('rejects reentrancy from an asset callback fired mid-deposit', async () => {
    const context = await deployVault();
    const { currency, vault } = context;
    const attackContract = await viem.deployContract('ReentrantVaultDepositor', [vault.address]);
    await currency.write.mint([attackContract.address, 100n * USDC]);
    await attackContract.write.approveAsset([currency.address, 100n * USDC]);

    await currency.write.setCallback([
      attackContract.address,
      encodeFunctionData({
        abi: attackContract.abi,
        functionName: 'reenter',
        args: [1n * USDC],
      }),
      true,
    ]);

    await attackContract.write.deposit([10n * USDC]);

    assert.equal(await attackContract.read.reentryAttempts(), 1n, 'the nested deposit was tried');
    assert.equal(await attackContract.read.reentryReverted(), true, 'and it was refused');
    // Exactly the outer deposit landed.
    assert.equal(await vault.read.totalAssets(), 10n * USDC);
    await assertSolvent(context, 'after reentrancy attempt');
  });

  it('exposes no owner, pauser, or drain surface', async () => {
    const { vault } = await deployVault();
    const names = vault.abi.filter((entry) => entry.type === 'function').map((entry) => entry.name);
    for (const forbidden of [
      'owner', 'transferOwnership', 'pause', 'unpause', 'rescue', 'sweep',
      'setFee', 'skim', 'emergencyWithdraw', 'upgradeTo',
    ]) {
      assert.equal(names.includes(forbidden), false, `${forbidden} must not exist`);
    }
  });

  it('lets nobody withdraw another wallet assets, including the deployer', async () => {
    const context = await deployVault();
    const { currency, vault } = context;
    await fund(currency, vault, alice, 50n * USDC);
    await vault.write.deposit([50n * USDC, alice.account.address], { account: alice.account });

    for (const account of [deployer.account, bob.account, attacker.account]) {
      await assert.rejects(
        vault.write.withdraw([50n * USDC, account.address, alice.account.address], { account }),
      );
      await assert.rejects(
        vault.write.redeem([1_000_000n, account.address, alice.account.address], { account }),
      );
    }
    assert.equal(await vault.read.maxWithdraw([alice.account.address]), 50n * USDC);
    await assertSolvent(context, 'after unauthorized withdrawal attempts');
  });

  it('mints an exact share count and rounds the cost against the depositor', async () => {
    const context = await deployVault();
    const { currency, vault } = context;
    await fund(currency, vault, alice, 100n * USDC);

    const targetShares = 12_345n;
    const cost = await vault.read.previewMint([targetShares]);
    await vault.write.mint([targetShares, alice.account.address], { account: alice.account });

    assert.equal(await vault.read.balanceOf([alice.account.address]), targetShares);
    assert.equal(await vault.read.totalAssets(), cost);
    // Rounding must never let a depositor redeem more than they paid in.
    assert.ok(await vault.read.previewRedeem([targetShares]) <= cost);
    await assertSolvent(context, 'after exact mint');
  });
});

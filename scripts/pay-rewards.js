/**
 * Pays finalized MemeVerse rewards in USDC from the treasury, which is where the platform fee lands.
 *
 * Read-only by default: prints every payout and the safety checks. `--broadcast` sends them.
 *   node scripts/pay-rewards.js              # plan only
 *   node scripts/pay-rewards.js --broadcast  # pay
 *
 * Safety:
 *   - Only weeks that have ended are paid, and only balances of at least MIN_PAYOUT_USDC.
 *   - The total can never exceed (trading + referral share) of the treasury fees of ended weeks.
 *   - The signer must be the treasury every market pays its fee to.
 *   - A lock file stops concurrent runs; each payout is written to the ledger before it is sent,
 *     and a run refuses to start while any earlier payout is still unresolved ("pending").
 */
import { open, readFile, rename, unlink, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arc } from 'viem/chains';
import { assertMainnetChainId, parseDeployerPrivateKey } from './mainnet-deploy-plan.js';
import { REFERRAL_SHARE_BPS, TRADING_SHARE_BPS, computeRewards, payoutPlan } from '../src/rewards.js';
import { readPayouts, readReferrals } from '../server/domain/rewards-service.js';

const USDC = '0x3600000000000000000000000000000000000000';
const usdcAbi = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const factoryAbi = parseAbi(['function treasury() view returns (address)']);

/** Pure: the plan plus the invariant that payouts stay within the revenue share of ended weeks. */
export function plannedPayouts({ trades, referrals, payouts, nowSeconds, exclude }) {
  const result = computeRewards({ trades, referrals, payouts, nowSeconds, exclude });
  const plan = payoutPlan(result);
  const endedFees = Object.values(result.epochs).filter((epoch) => epoch.final).reduce((sum, epoch) => sum + epoch.fees, 0n);
  const ceiling = (endedFees * (TRADING_SHARE_BPS + REFERRAL_SHARE_BPS)) / 10_000n;
  const alreadyPaid = payouts.filter((entry) => ['sent', 'confirmed'].includes(entry.status)).reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
  const total = plan.reduce((sum, item) => sum + item.amount, 0n);
  if (alreadyPaid + total > ceiling) throw new Error('Payouts would exceed the revenue share of ended weeks; nothing was sent.');
  return { plan, total, ceiling, alreadyPaid, endedFees };
}

async function environment() {
  let stored = {};
  try {
    const content = await readFile(process.env.MEMEVERSE_ENV || '/etc/memeverse/memeverse.env', 'utf8');
    stored = Object.fromEntries(content.split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')];
    }));
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read the environment file.'); }
  return { ...stored, ...process.env };
}

async function writeLedger(file, payouts) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ payouts }, null, 2) + '\n', { mode: 0o640 });
  await rename(temporary, file);
}

async function main() {
  const env = await environment();
  const broadcast = process.argv.includes('--broadcast');
  const storageDir = env.MEDIA_STORAGE_DIR;
  if (!storageDir) throw new Error('MEDIA_STORAGE_DIR is required.');
  const rewardsDir = join(storageDir, 'rewards');
  const ledgerFile = join(rewardsDir, 'payouts.json');
  const client = createPublicClient({ chain: arc, transport: http(env.ARC_RPC_URL || 'https://rpc.mainnet.arc.io') });
  assertMainnetChainId(await client.getChainId());

  const factories = [env.VITE_MEMEVERSE_FACTORY_ADDRESS, env.VITE_FRACTIONAL_FACTORY_ADDRESS].filter(Boolean);
  const treasuries = [...new Set(await Promise.all(factories.map((address) => client.readContract({ address, abi: factoryAbi, functionName: 'treasury' }))))];
  if (treasuries.length !== 1) throw new Error('Factories disagree on the treasury; resolve before paying.');
  const treasury = getAddress(treasuries[0]);

  const state = JSON.parse(await readFile(join(storageDir, 'activity', 'state.json'), 'utf8'));
  const trades = state.trades.map((trade) => ({ ...trade, at: state.blockTimes[trade.block] ?? null }));
  const [referrals, payouts] = await Promise.all([readReferrals(storageDir), readPayouts(storageDir)]);
  if (payouts.some((entry) => entry.status === 'pending')) {
    throw new Error('An earlier payout is unresolved (status "pending"). Check it on the explorer and update the ledger first.');
  }
  const nowSeconds = Number((await client.getBlock()).timestamp);
  const { plan, total, ceiling, alreadyPaid, endedFees } = plannedPayouts({ trades, referrals, payouts, nowSeconds, exclude: [treasury] });
  const balance = await client.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [treasury] });
  console.log(JSON.stringify({
    mode: broadcast ? 'broadcast' : 'plan', treasury, treasuryUsdc: formatUnits(balance, 6),
    endedWeekFees: formatUnits(endedFees, 6), shareCeiling: formatUnits(ceiling, 6), alreadyPaid: formatUnits(alreadyPaid, 6),
    payouts: plan.map((item) => ({ wallet: getAddress(item.wallet), usdc: formatUnits(item.amount, 6) })), total: formatUnits(total, 6),
  }, null, 2));
  if (!broadcast || plan.length === 0) return;
  if (balance < total) throw new Error('The treasury holds less USDC than this payout; nothing was sent.');
  const account = privateKeyToAccount(parseDeployerPrivateKey(env.DEPLOYER_PRIVATE_KEY));
  if (getAddress(account.address) !== treasury) throw new Error('The signing key is not the treasury; nothing was sent.');

  await mkdir(rewardsDir, { recursive: true });
  const lockFile = join(rewardsDir, 'payout.lock');
  const lock = await open(lockFile, 'wx').catch(() => { throw new Error('Another payout run holds the lock.'); });
  try {
    const signer = createWalletClient({ account, chain: arc, transport: http(env.ARC_RPC_URL || 'https://rpc.mainnet.arc.io') });
    const ledger = [...payouts];
    for (const item of plan) {
      const entry = { wallet: getAddress(item.wallet), amount: item.amount.toString(), status: 'pending', at: new Date().toISOString() };
      ledger.push(entry);
      await writeLedger(ledgerFile, ledger); // Recorded before sending: an interruption never pays twice.
      entry.tx = await signer.writeContract({ address: USDC, abi: usdcAbi, functionName: 'transfer', args: [entry.wallet, item.amount] });
      entry.status = 'sent';
      await writeLedger(ledgerFile, ledger);
      const receipt = await client.waitForTransactionReceipt({ hash: entry.tx });
      entry.status = receipt.status === 'success' ? 'confirmed' : 'failed';
      await writeLedger(ledgerFile, ledger);
      console.log(JSON.stringify({ wallet: entry.wallet, usdc: formatUnits(item.amount, 6), tx: entry.tx, status: entry.status }));
    }
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

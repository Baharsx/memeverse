import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAddress, isAddress } from 'viem';
import { DomainError } from './errors.js';
import {
  MIN_PAYOUT_USDC, REFERRAL_SHARE_BPS, TRADING_SHARE_BPS, computeRewards, epochBounds,
} from '../../src/rewards.js';

const text = (value) => (typeof value === 'bigint' ? value.toString() : value);

/** Reads the signed referral registrations, one file per invited wallet. */
export async function readReferrals(storageDir) {
  const directory = join(storageDir, 'referrals');
  let names = [];
  try { names = await readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const records = [];
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    try { records.push(JSON.parse(await readFile(join(directory, name), 'utf8'))); } catch { /* A partial file is skipped. */ }
  }
  return records;
}

/** The payout ledger written by scripts/pay-rewards.js. */
export async function readPayouts(storageDir) {
  try {
    return JSON.parse(await readFile(join(storageDir, 'rewards', 'payouts.json'), 'utf8')).payouts ?? [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Public, read-only view of the revenue-funded rewards: this week's pool, the leaderboard, past
 * weeks and any wallet's own numbers. Everything derives from public chain data, the signed
 * referral records and the payout ledger; no wallet-to-wallet referral link is ever returned.
 */
export class RewardsService {
  constructor({ indexer, storageDir, exclude = [], clock = () => Date.now(), cacheMs = 5_000 }) {
    this.indexer = indexer;
    this.storageDir = storageDir;
    this.exclude = exclude;
    this.clock = clock;
    this.cacheMs = cacheMs;
    this.cached = null;
  }

  get available() {
    return Boolean(this.indexer?.available);
  }

  async result() {
    const now = this.clock();
    if (this.cached && now - this.cached.at < this.cacheMs) return this.cached.value;
    const [referrals, payouts] = await Promise.all([readReferrals(this.storageDir), readPayouts(this.storageDir)]);
    const value = {
      rewards: computeRewards({ trades: this.indexer.trades(), referrals, payouts, nowSeconds: Math.floor(now / 1000), exclude: this.exclude }),
      payouts,
    };
    this.cached = { at: now, value };
    return value;
  }

  async summary() {
    const { rewards, payouts } = await this.result();
    const epoch = rewards.epochs[rewards.current] ?? { ...epochBounds(rewards.current), fees: 0n, volume: 0n, trades: 0, tradingPool: 0n, referralPaid: 0n, traders: {} };
    const leaderboard = Object.entries(epoch.traders)
      .sort(([, a], [, b]) => (b > a ? 1 : b < a ? -1 : 0))
      .slice(0, 10)
      .map(([wallet, volume], index) => ({
        rank: index + 1,
        wallet: getAddress(wallet),
        volume: text(volume),
        reward: text(rewards.wallets[wallet]?.epochs[rewards.current]?.trading ?? 0n),
      }));
    const history = Object.values(rewards.epochs)
      .filter((item) => item.final)
      .sort((a, b) => b.epoch - a.epoch)
      .map((item) => ({ epoch: item.epoch, start: item.start, end: item.end, volume: text(item.volume), trades: item.trades, tradingPool: text(item.tradingPool), referral: text(item.referralPaid), traders: Object.keys(item.traders).length }));
    const confirmed = payouts.filter((entry) => entry.status === 'confirmed');
    return {
      program: { tradingShareBps: Number(TRADING_SHARE_BPS), referralShareBps: Number(REFERRAL_SHARE_BPS), minPayout: text(MIN_PAYOUT_USDC) },
      current: {
        epoch: epoch.epoch, start: epoch.start, end: epoch.end, volume: text(epoch.volume), trades: epoch.trades,
        tradingPool: text(epoch.tradingPool), referral: text(epoch.referralPaid), traders: Object.keys(epoch.traders).length,
      },
      leaderboard,
      history,
      paid: {
        total: text(confirmed.reduce((sum, entry) => sum + BigInt(entry.amount), 0n)),
        recent: confirmed.slice(-5).reverse().map((entry) => ({ wallet: entry.wallet, amount: entry.amount, tx: entry.tx, at: entry.at })),
      },
    };
  }

  async wallet(value) {
    if (!isAddress(String(value ?? ''))) throw new DomainError('INVALID_WALLET', 'Enter a valid wallet address.', { status: 400 });
    const { rewards } = await this.result();
    const entry = rewards.wallets[String(value).toLowerCase()];
    const week = entry?.epochs[rewards.current];
    return {
      wallet: getAddress(value),
      epoch: rewards.current,
      thisWeek: { volume: text(week?.volume ?? 0n), trading: text(week?.trading ?? 0n), referral: text(week?.referral ?? 0n) },
      earned: text(entry?.earned ?? 0n),
      paid: text(entry?.paid ?? 0n),
      unpaid: text(entry?.unpaid ?? 0n),
      invited: entry?.invited ?? 0,
      invitedTraded: entry?.invitedTraded ?? 0,
    };
  }
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { decodeEventLog, getAddress, parseAbi } from 'viem';
import { PROGRAM_START } from '../../src/rewards.js';

/**
 * Indexes public trade activity for every registered MemeVerse market.
 *
 * The Arc RPC caps eth_getLogs at fewer than 10,000 blocks, so browsers cannot read history
 * themselves. This loop walks forward in bounded chunks from each factory's deployment block,
 * keeps buys, sells and token balances, and persists a compact JSON state so a restart resumes
 * from its cursor. It only reads public chain data and never holds keys or sends transactions.
 *
 * Both market versions emit identical Bought/Sold/Transfer signatures; amounts are token units
 * (18 decimals) and USDC units (6 decimals).
 */
export const activityAbi = parseAbi([
  'event Bought(address indexed buyer, uint256 maximumUsdcIn, uint256 actualUsdcSpent, uint256 tokenOut, uint256 curveCostUsdc, uint256 creatorFeeUsdc, uint256 treasuryFeeUsdc, uint256 soldAfter)',
  'event Sold(address indexed seller, uint256 tokenIn, uint256 usdcOut, uint256 grossCurveReturnUsdc, uint256 creatorFeeUsdc, uint256 treasuryFeeUsdc, uint256 soldAfter)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const factoryAbi = parseAbi([
  'function marketCount() view returns (uint256)',
  'function markets(uint256) view returns (address)',
  'function isMarket(address) view returns (bool)',
  'function deployedAtBlock() view returns (uint256)',
]);
const marketAbi = parseAbi(['function createdBlock() view returns (uint256)']);

export const LOG_CHUNK_BLOCKS = 9_000n;
export const DAY_SECONDS = 86_400;
const ZERO = '0x0000000000000000000000000000000000000000';
const STATE_VERSION = 1;

function emptyState() {
  return { version: STATE_VERSION, cursor: null, markets: {}, trades: [], balances: {}, blockTimes: {} };
}

/** Pure reducer: applies decoded logs (in chain order) to the state. Exported for tests. */
export function applyLogs(state, logs) {
  const seen = new Set(state.trades.map((trade) => trade.id));
  for (const log of logs) {
    const market = getAddress(log.address);
    if (!state.markets[market]) continue;
    let event;
    try {
      event = decodeEventLog({ abi: activityAbi, data: log.data, topics: log.topics });
    } catch {
      continue; // Approval and any unrelated event.
    }
    const id = `${log.transactionHash}:${log.logIndex}`;
    if (event.eventName === 'Transfer') {
      const balances = (state.balances[market] ??= {});
      const { from, to, value } = event.args;
      for (const [holder, delta] of [[from, -value], [to, value]]) {
        const key = getAddress(holder);
        if (key === ZERO || key === market) continue; // Mint/burn and curve inventory are not holders.
        const next = BigInt(balances[key] ?? '0') + delta;
        if (next > 0n) balances[key] = next.toString(); else delete balances[key];
      }
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const buy = event.eventName === 'Bought';
    state.trades.push({
      id,
      market,
      side: buy ? 'BUY' : 'SELL',
      trader: getAddress(buy ? event.args.buyer : event.args.seller),
      usdc: (buy ? event.args.actualUsdcSpent : event.args.usdcOut).toString(),
      treasuryFee: event.args.treasuryFeeUsdc.toString(),
      creatorFee: event.args.creatorFeeUsdc.toString(),
      tokens: (buy ? event.args.tokenOut : event.args.tokenIn).toString(),
      block: log.blockNumber.toString(),
      tx: log.transactionHash,
    });
  }
  return state;
}

/** Aggregates per-market statistics at `nowSeconds`. Exported for tests. */
export function marketStats(state, nowSeconds) {
  const since = nowSeconds - DAY_SECONDS;
  const stats = {};
  for (const market of Object.keys(state.markets)) {
    stats[market] = {
      holders: Object.keys(state.balances[market] ?? {}).length,
      trades: 0, volumeUsdc: '0', trades24h: 0, volume24hUsdc: '0', traders24h: 0, lastTradeAt: null,
    };
  }
  const traders = {};
  for (const trade of state.trades) {
    const entry = stats[trade.market];
    if (!entry) continue;
    const at = state.blockTimes[trade.block] ?? null;
    entry.trades += 1;
    entry.volumeUsdc = (BigInt(entry.volumeUsdc) + BigInt(trade.usdc)).toString();
    if (at !== null && (entry.lastTradeAt === null || at > entry.lastTradeAt)) entry.lastTradeAt = at;
    if (at !== null && at >= since) {
      entry.trades24h += 1;
      entry.volume24hUsdc = (BigInt(entry.volume24hUsdc) + BigInt(trade.usdc)).toString();
      (traders[trade.market] ??= new Set()).add(trade.trader);
    }
  }
  for (const [market, set] of Object.entries(traders)) stats[market].traders24h = set.size;
  // Rolling windows for the trending toggles; `all` covers every indexed trade.
  for (const [period, seconds] of Object.entries(STAT_PERIODS)) {
    const from = seconds === null ? null : nowSeconds - seconds;
    for (const entry of Object.values(stats)) (entry.periods ??= {})[period] = { trades: 0, volumeUsdc: '0' };
    for (const trade of state.trades) {
      const entry = stats[trade.market];
      const at = state.blockTimes[trade.block] ?? null;
      if (!entry || (from !== null && (at === null || at < from))) continue;
      const window = entry.periods[period];
      window.trades += 1;
      window.volumeUsdc = (BigInt(window.volumeUsdc) + BigInt(trade.usdc)).toString();
    }
  }
  return stats;
}

export const STAT_PERIODS = Object.freeze({ '24h': DAY_SECONDS, '7d': 7 * DAY_SECONDS, '30d': 30 * DAY_SECONDS, all: null });

export function recentTrades(state, limit = 20) {
  return state.trades
    .slice()
    .sort((a, b) => (BigInt(b.block) === BigInt(a.block) ? b.id.localeCompare(a.id) : (BigInt(b.block) > BigInt(a.block) ? 1 : -1)))
    .slice(0, limit)
    .map(({ id: _id, block, ...trade }) => ({ ...trade, at: state.blockTimes[block] ?? null }));
}

export class ActivityIndexer {
  constructor({
    publicClient, factories, stateFile, logger = console, pollMs = 5_000, chunkBlocks = LOG_CHUNK_BLOCKS,
    spacingMs = 300, sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  }) {
    this.publicClient = publicClient;
    this.factories = [...new Set(factories.filter(Boolean).map((address) => getAddress(address)))];
    this.stateFile = stateFile;
    this.logger = logger;
    this.pollMs = pollMs;
    this.chunkBlocks = chunkBlocks;
    this.spacingMs = spacingMs;
    this.sleep = sleep;
    this.lastCallAt = 0;
    this.state = emptyState();
    this.latest = null;
    this.timer = null;
    this.running = false;
  }

  get available() {
    return this.factories.length > 0;
  }

  status() {
    const cursor = this.state.cursor === null ? null : BigInt(this.state.cursor);
    return {
      syncing: cursor === null || this.latest === null || cursor < this.latest - this.chunkBlocks,
      cursor: cursor?.toString() ?? null,
      latest: this.latest?.toString() ?? null,
    };
  }

  async load() {
    try {
      const stored = JSON.parse(await readFile(this.stateFile, 'utf8'));
      if (stored.version === STATE_VERSION) this.state = { ...emptyState(), ...stored };
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.warn?.(JSON.stringify({ type: 'activity_state_unreadable', message: error.message }));
    }
  }

  async save() {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state), { mode: 0o640 });
    await rename(temporary, this.stateFile);
  }

  /**
   * Paces RPC calls and backs off on rate limits, timeouts and transient gateway errors. The public
   * Arc RPC throttles bursts, and this background job prefers arriving a little later over failing.
   */
  async call(operation) {
    for (let attempt = 0; ; attempt += 1) {
      const wait = this.lastCallAt + this.spacingMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCallAt = Date.now();
      try {
        return await operation();
      } catch (error) {
        const text = `${error?.shortMessage ?? ''} ${error?.details ?? ''} ${error?.message ?? ''} ${error?.code ?? ''}`;
        if (attempt >= 6 || !/rate limit|exceeds defined limit|429|-32005|too many|timed out|took too long|timeout|fetch failed|ECONNRESET|50[234]/i.test(text)) throw error;
        await this.sleep(Math.min(30_000, 1_000 * 2 ** attempt));
      }
    }
  }

  async read(address, functionName, args) {
    return this.call(() => this.publicClient.readContract({ address, abi: [...factoryAbi, ...marketAbi], functionName, args }));
  }

  async logs(addresses, fromBlock, toBlock) {
    const all = [];
    for (let from = fromBlock; from <= toBlock; from += this.chunkBlocks) {
      const to = from + this.chunkBlocks - 1n < toBlock ? from + this.chunkBlocks - 1n : toBlock;
      all.push(...await this.call(() => this.publicClient.getLogs({ address: addresses, fromBlock: from, toBlock: to })));
    }
    return all;
  }

  /** Registers markets the factories list but the state does not know yet, catching each up. */
  async discoverMarkets() {
    for (const factory of this.factories) {
      const count = await this.read(factory, 'marketCount');
      for (let index = 0n; index < count; index += 1n) {
        const market = getAddress(await this.read(factory, 'markets', [index]));
        if (this.state.markets[market]) continue;
        if (!(await this.read(factory, 'isMarket', [market]))) continue;
        const createdBlock = await this.read(market, 'createdBlock');
        this.state.markets[market] = { factory, createdBlock: createdBlock.toString() };
        // A market born behind the cursor needs its own history up to the cursor.
        if (this.state.cursor !== null && createdBlock <= BigInt(this.state.cursor)) {
          applyLogs(this.state, await this.logs([market], createdBlock, BigInt(this.state.cursor)));
        }
      }
    }
  }

  async stampTimes() {
    const missing = [...new Set(this.state.trades.map((trade) => trade.block))].filter((block) => !(block in this.state.blockTimes));
    for (const block of missing) {
      const { timestamp } = await this.call(() => this.publicClient.getBlock({ blockNumber: BigInt(block) }));
      this.state.blockTimes[block] = Number(timestamp);
    }
  }

  /**
   * Trades indexed before fees were recorded get theirs from the event logs of their own block, once.
   * Only trades the rewards program can count (from PROGRAM_START) are fetched; a block that cannot
   * be read is retried on a later tick and never stops the indexer.
   */
  async backfillFees() {
    const missing = this.state.trades.filter((trade) => trade.treasuryFee === undefined
      && (this.state.blockTimes[trade.block] ?? 0) >= PROGRAM_START);
    for (const block of [...new Set(missing.map((trade) => trade.block))]) {
      let logs;
      try {
        logs = await this.logs(Object.keys(this.state.markets), BigInt(block), BigInt(block));
      } catch {
        continue;
      }
      for (const trade of missing.filter((item) => item.block === block)) {
        const logIndex = Number(trade.id.split(':')[1]);
        const log = logs.find((item) => item.transactionHash === trade.tx && Number(item.logIndex) === logIndex);
        if (!log) continue;
        const { args } = decodeEventLog({ abi: activityAbi, data: log.data, topics: log.topics });
        trade.treasuryFee = args.treasuryFeeUsdc.toString();
        trade.creatorFee = args.creatorFeeUsdc.toString();
      }
    }
  }

  /** Every trade with its block time, for the rewards ledger. */
  trades() {
    return this.state.trades.map((trade) => ({ ...trade, at: this.state.blockTimes[trade.block] ?? null }));
  }

  async tick() {
    if (this.state.cursor === null) {
      const starts = await Promise.all(this.factories.map((factory) => this.read(factory, 'deployedAtBlock')));
      this.state.cursor = (starts.reduce((low, value) => (value < low ? value : low)) - 1n).toString();
    }
    await this.discoverMarkets();
    this.latest = await this.call(() => this.publicClient.getBlockNumber());
    const markets = Object.keys(this.state.markets);
    let cursor = BigInt(this.state.cursor);
    let chunks = 0;
    while (cursor < this.latest) {
      const to = cursor + this.chunkBlocks < this.latest ? cursor + this.chunkBlocks : this.latest;
      if (markets.length) applyLogs(this.state, await this.logs(markets, cursor + 1n, to));
      cursor = to;
      this.state.cursor = cursor.toString();
      chunks += 1;
      if (chunks % 25 === 0) await this.save(); // Long backfills resume close to where they stopped.
    }
    await this.stampTimes();
    await this.backfillFees();
    await this.save();
  }

  start() {
    if (!this.available || this.running) return;
    this.running = true;
    const loop = async () => {
      try {
        await this.tick();
      } catch (error) {
        this.logger.warn?.(JSON.stringify({ type: 'activity_index_failed', message: String(error?.shortMessage ?? error?.message ?? error).slice(0, 300) }));
      }
      if (this.running) this.timer = setTimeout(loop, this.pollMs);
    };
    this.load().then(loop);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  snapshot({ limit = 20, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
    return { recent: recentTrades(this.state, limit), markets: marketStats(this.state, nowSeconds), status: this.status() };
  }
}

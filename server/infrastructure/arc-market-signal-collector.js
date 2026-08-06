import { getAddress, parseAbi, parseAbiItem } from 'viem';
import { DomainError } from '../domain/errors.js';
import { calculateSignalMetrics, evidenceDigest } from '../domain/agent-signal-metrics.js';

/**
 * The trusted MemeVerse market signal collector.
 *
 * This is the only component permitted to assign `ONCHAIN_INDEXER` provenance, and it earns that
 * by reading everything it reports directly from Arc:
 *
 *   * the market must be registered in the configured trusted factory (`isMarket`);
 *   * the creator is read from the market contract, never supplied by a caller;
 *   * trade evidence comes from confirmed `Bought`/`Sold` logs, not the unstable head;
 *   * the observation timestamp comes from the anchor block, not the server clock.
 *
 * Reorg safety is a confirmation depth plus a recorded block anchor: the window always ends
 * `minConfirmations` behind the head, and the anchor block's hash is captured so it can be
 * re-checked immediately before money moves.
 */

const factoryAbi = parseAbi([
  'function isMarket(address) view returns (bool)',
  'function marketCount() view returns (uint256)',
  'function markets(uint256) view returns (address)',
]);

const marketAbi = parseAbi([
  'function creator() view returns (address)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function reserveUsdc() view returns (uint256)',
  'function soldTokenCount() view returns (uint256)',
  'function createdBlock() view returns (uint256)',
]);

const boughtEvent = parseAbiItem(
  'event Bought(address indexed buyer, uint256 maximumUsdcIn, uint256 actualUsdcSpent, uint256 tokenOut, uint256 curveCostUsdc, uint256 creatorFeeUsdc, uint256 treasuryFeeUsdc, uint256 soldTokenCount)',
);
const soldEvent = parseAbiItem(
  'event Sold(address indexed seller, uint256 tokenIn, uint256 usdcOut, uint256 grossCurveReturnUsdc, uint256 creatorFeeUsdc, uint256 treasuryFeeUsdc, uint256 soldTokenCount)',
);

export const SIGNAL_COLLECTOR_ID = 'ARC_MARKET_SIGNAL_COLLECTOR_V1';

export class ArcMarketSignalCollector {
  constructor({
    publicClient,
    chainId,
    factoryAddress,
    minConfirmations,
    lookbackBlocks,
    // Arc's public RPC rejects log ranges much beyond ten thousand blocks and rate-limits
    // bursts, so pages are large but requested one at a time with backoff.
    logPageSize = 10_000n,
    logRequestDelayMs = 250,
    logRetryAttempts = 5,
    metricConfig,
    policyVersion,
  }) {
    this.publicClient = publicClient;
    this.chainId = chainId;
    this.factoryAddress = getAddress(factoryAddress);
    this.minConfirmations = BigInt(minConfirmations);
    this.lookbackBlocks = BigInt(lookbackBlocks);
    this.logPageSize = BigInt(logPageSize);
    this.logRequestDelayMs = logRequestDelayMs;
    this.logRetryAttempts = logRetryAttempts;
    this.metricConfig = metricConfig;
    this.policyVersion = policyVersion;
  }

  /** Every market the trusted factory has ever registered. */
  async listRegisteredMarkets() {
    const count = await this.publicClient.readContract({
      address: this.factoryAddress, abi: factoryAbi, functionName: 'marketCount',
    });
    const markets = [];
    for (let index = 0n; index < count; index += 1n) {
      markets.push(getAddress(await this.publicClient.readContract({
        address: this.factoryAddress, abi: factoryAbi, functionName: 'markets', args: [index],
      })));
    }
    return markets;
  }

  /**
   * Confirms a market really belongs to the trusted factory and reads its creator from the
   * market itself. Both facts are re-read, never cached from an earlier pass.
   */
  async resolveMarket(marketAddress) {
    const address = getAddress(marketAddress);
    const registered = await this.publicClient.readContract({
      address: this.factoryAddress, abi: factoryAbi, functionName: 'isMarket', args: [address],
    });
    if (!registered) {
      throw new DomainError(
        'MARKET_NOT_REGISTERED',
        'The market is not registered in the trusted MemeVerse factory.',
        { status: 422, details: { market: address, factory: this.factoryAddress } },
      );
    }
    const [creator, symbol, createdBlock] = await Promise.all([
      this.publicClient.readContract({ address, abi: marketAbi, functionName: 'creator' }),
      this.publicClient.readContract({ address, abi: marketAbi, functionName: 'symbol' }),
      this.publicClient.readContract({ address, abi: marketAbi, functionName: 'createdBlock' }),
    ]);
    return {
      marketAddress: address,
      creatorAddress: getAddress(creator),
      symbol,
      createdBlock,
    };
  }

  /**
   * Reads logs in bounded pages, one request at a time, retrying on transient RPC pushback.
   *
   * Pages are sequential rather than parallel deliberately: a burst of concurrent page requests
   * is exactly what trips the public RPC's rate limiter, and a rate-limited page is
   * indistinguishable from an empty one at the JSON-RPC layer. Silently treating a throttled
   * read as "no trades happened" would understate activity, so an exhausted retry budget
   * propagates and the caller marks the evidence incomplete instead.
   */
  async #paginatedLogs({ address, event, fromBlock, toBlock }) {
    const logs = [];
    for (let start = fromBlock; start <= toBlock; start += this.logPageSize) {
      const end = start + this.logPageSize - 1n > toBlock ? toBlock : start + this.logPageSize - 1n;
      let page;
      for (let attempt = 0; attempt < this.logRetryAttempts; attempt += 1) {
        try {
          page = await this.publicClient.getLogs({ address, event, fromBlock: start, toBlock: end });
          break;
        } catch (error) {
          if (attempt === this.logRetryAttempts - 1) throw error;
          // Exponential backoff: the limiter needs quiet time, not a faster retry.
          await new Promise((resolve) => setTimeout(resolve, this.logRequestDelayMs * (2 ** attempt)));
        }
      }
      logs.push(...page);
      if (start + this.logPageSize <= toBlock) {
        await new Promise((resolve) => setTimeout(resolve, this.logRequestDelayMs));
      }
    }
    return logs;
  }

  /**
   * Collects one market's confirmed evidence and reduces it to signals.
   *
   * The chain ID is re-verified on every collection: a silently reconfigured or failed-over RPC
   * pointing at another network must not be able to feed evidence into a payout decision.
   */
  async collect(marketAddress) {
    const chainId = await this.publicClient.getChainId();
    if (chainId !== this.chainId) {
      throw new DomainError('ARC_CHAIN_MISMATCH', 'Arc RPC reported an unexpected chain ID.', {
        status: 502, details: { expected: this.chainId, actual: chainId },
      });
    }

    const market = await this.resolveMarket(marketAddress);
    const headBlock = await this.publicClient.getBlockNumber();
    if (headBlock < this.minConfirmations) {
      throw new DomainError('ARC_HEAD_TOO_SHALLOW', 'Arc head is below the confirmation depth.', {
        status: 503,
      });
    }

    // The window always ends behind the head by the configured confirmation depth.
    const toBlock = headBlock - this.minConfirmations;
    const windowStart = toBlock > this.lookbackBlocks ? toBlock - this.lookbackBlocks : 0n;
    const fromBlock = windowStart > market.createdBlock ? windowStart : market.createdBlock;
    if (fromBlock > toBlock) {
      throw new DomainError(
        'ARC_EVIDENCE_WINDOW_EMPTY',
        'The market is newer than the confirmed evidence window.',
        { status: 422, details: { fromBlock: fromBlock.toString(), toBlock: toBlock.toString() } },
      );
    }

    const anchor = await this.publicClient.getBlock({ blockNumber: toBlock });
    if (!anchor?.hash) {
      throw new DomainError('ARC_ANCHOR_UNAVAILABLE', 'The evidence anchor block is unavailable.', {
        status: 503,
      });
    }

    let logsComplete = true;
    let boughtLogs = [];
    let soldLogs = [];
    try {
      // Sequential, not concurrent: see #paginatedLogs on why bursts are self-defeating here.
      boughtLogs = await this.#paginatedLogs({
        address: market.marketAddress, event: boughtEvent, fromBlock, toBlock,
      });
      soldLogs = await this.#paginatedLogs({
        address: market.marketAddress, event: soldEvent, fromBlock, toBlock,
      });
    } catch {
      // A partial log read must never look like a quiet market: it collapses confidence to zero
      // and raises risk, so the policy declines rather than paying on missing history.
      logsComplete = false;
    }

    const [reserveUsdcUnits, soldTokenCount] = await Promise.all([
      this.publicClient.readContract({
        address: market.marketAddress, abi: marketAbi, functionName: 'reserveUsdc',
        blockNumber: toBlock,
      }),
      this.publicClient.readContract({
        address: market.marketAddress, abi: marketAbi, functionName: 'soldTokenCount',
        blockNumber: toBlock,
      }),
    ]);

    const buys = boughtLogs.map((log) => ({
      trader: getAddress(log.args.buyer),
      usdcUnits: log.args.actualUsdcSpent,
      tokens: log.args.tokenOut,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
    }));
    const sells = soldLogs.map((log) => ({
      trader: getAddress(log.args.seller),
      usdcUnits: log.args.usdcOut,
      tokens: log.args.tokenIn,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
    }));

    const metrics = calculateSignalMetrics({
      buys,
      sells,
      reserveUsdcUnits,
      marketCreatedBlock: market.createdBlock,
      fromBlock,
      toBlock,
      headBlock,
      minConfirmations: Number(this.minConfirmations),
      logsComplete,
    }, this.metricConfig);

    const digest = evidenceDigest({
      chainId,
      factoryAddress: this.factoryAddress,
      marketAddress: market.marketAddress,
      creatorAddress: market.creatorAddress,
      metrics,
      blockHash: anchor.hash,
      policyVersion: this.policyVersion,
    });

    return Object.freeze({
      collector: SIGNAL_COLLECTOR_ID,
      chainId,
      factoryAddress: this.factoryAddress,
      marketAddress: market.marketAddress,
      creatorAddress: market.creatorAddress,
      marketSymbol: market.symbol,
      soldTokenCount: soldTokenCount.toString(),
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      headBlock: headBlock.toString(),
      anchorBlockNumber: toBlock.toString(),
      anchorBlockHash: anchor.hash,
      // Derived from the anchor block, never from the server clock, so freshness is measured in
      // chain time and cannot be widened by a skewed host.
      observedAt: new Date(Number(anchor.timestamp) * 1000).toISOString(),
      observedAtSeconds: Number(anchor.timestamp),
      metrics,
      evidenceDigest: digest,
      policyVersion: this.policyVersion,
    });
  }

  /**
   * Re-asserts, immediately before money moves, everything that could have changed while the
   * agent was deciding. Any drift fails closed.
   */
  async verifyEvidenceStillCanonical(evidence) {
    const chainId = await this.publicClient.getChainId();
    if (chainId !== this.chainId) {
      throw new DomainError('ARC_CHAIN_MISMATCH', 'Arc RPC reported an unexpected chain ID.', {
        status: 502,
      });
    }
    const anchor = await this.publicClient.getBlock({
      blockNumber: BigInt(evidence.anchorBlockNumber),
    });
    if (!anchor?.hash) {
      throw new DomainError('ARC_ANCHOR_UNAVAILABLE', 'The evidence anchor block is unavailable.', {
        status: 503,
      });
    }
    if (anchor.hash !== evidence.anchorBlockHash) {
      // The anchor was reorganised out. The evidence describes a chain that no longer exists.
      throw new DomainError(
        'ARC_ANCHOR_REORGANISED',
        'The evidence anchor block hash no longer matches the canonical chain.',
        { status: 409, details: { anchorBlockNumber: evidence.anchorBlockNumber } },
      );
    }
    const market = await this.resolveMarket(evidence.marketAddress);
    if (market.creatorAddress !== getAddress(evidence.creatorAddress)) {
      throw new DomainError(
        'MARKET_CREATOR_CHANGED',
        'The market creator changed after the decision was made.',
        { status: 409 },
      );
    }
    return { chainId, anchorBlockHash: anchor.hash, creatorAddress: market.creatorAddress };
  }
}

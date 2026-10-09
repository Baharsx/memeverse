import { createPublicClient, getAddress, http, parseAbi } from 'viem';
import { DomainError } from '../domain/errors.js';

const factoryAbi = parseAbi([
  'function isMarket(address) view returns (bool)',
]);

const marketAbi = parseAbi([
  'function creator() view returns (address)',
]);

/**
 * Confirms a market belongs to the trusted factory and reads its creator from the market.
 *
 * Media uploads are the only caller. Both facts are re-read on every upload, never taken from
 * the request.
 */
export class MarketResolver {
  constructor({ publicClient, factoryAddress }) {
    this.publicClient = publicClient;
    this.factoryAddress = factoryAddress ? getAddress(factoryAddress) : null;
  }

  async resolveMarket(marketAddress) {
    if (!this.factoryAddress) {
      throw new DomainError(
        'MARKET_NOT_REGISTERED',
        'No market factory is configured for this network.',
        { status: 422 },
      );
    }
    const address = getAddress(marketAddress);
    const registered = await this.publicClient.readContract({
      address: this.factoryAddress,
      abi: factoryAbi,
      functionName: 'isMarket',
      args: [address],
    });
    if (!registered) {
      throw new DomainError(
        'MARKET_NOT_REGISTERED',
        'The market is not registered in the trusted MemeVerse factory.',
        { status: 422, details: { market: address, factory: this.factoryAddress } },
      );
    }
    const creator = await this.publicClient.readContract({
      address,
      abi: marketAbi,
      functionName: 'creator',
    });
    return {
      marketAddress: address,
      creatorAddress: getAddress(creator),
    };
  }
}

export function createMarketResolver(config) {
  return new MarketResolver({
    publicClient: createPublicClient({ transport: http(config.arcRpcUrl) }),
    factoryAddress: config.marketFactoryAddress,
  });
}

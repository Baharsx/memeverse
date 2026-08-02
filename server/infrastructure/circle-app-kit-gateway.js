import { DomainError } from '../domain/errors.js';
import { createCircleStablecoinKitClient } from './circle-stablecoin-kit-client.js';

const arcTestnetCapabilities = Object.freeze([
  { operation: 'SEND', implemented: false, assets: ['USDC', 'EURC', 'cirBTC'] },
  { operation: 'BRIDGE', implemented: false, assets: ['USDC'] },
  {
    operation: 'SWAP',
    implemented: true,
    actions: ['ESTIMATE'],
    assets: ['USDC', 'EURC', 'cirBTC'],
    requiresKitKey: true,
  },
  { operation: 'UNIFIED_BALANCE', implemented: false, assets: ['USDC'] },
]);

export class CircleAppKitGateway {
  constructor({ config, client = null }) {
    this.config = config;
    this.client = client;
  }

  configuration() {
    const runtimeEnabled = Boolean(this.client && this.config.circleKitKey);
    return {
      provider: 'CIRCLE_STABLECOIN_KITS_API',
      network: 'Arc_Testnet',
      kitKeyConfigured: Boolean(this.config.circleKitKey),
      runtimeEnabled,
      runtimeMode: runtimeEnabled ? 'SERVER_SIDE_NATIVE_FETCH' : 'DISABLED',
      dependencyStatus: runtimeEnabled ? 'AVAILABLE_AUDIT_CLEAN' : 'NOT_CONFIGURED',
      capabilities: arcTestnetCapabilities.map((capability) => ({
        ...capability,
        enabled: runtimeEnabled && capability.implemented,
      })),
    };
  }

  async estimateSwap(input) {
    if (!this.client) {
      throw new DomainError(
        'APP_KIT_RUNTIME_UNAVAILABLE',
        'The server-side Stablecoin Kits runtime is unavailable.',
        { status: 503 },
      );
    }
    if (!this.config.circleKitKey) {
      throw new DomainError('CIRCLE_KIT_KEY_REQUIRED', 'A server-side Circle Kit Key is required.', {
        status: 503,
      });
    }
    return this.client.estimateSwap(input);
  }
}

export function createCircleAppKitGateway(config, {
  circleGateway,
  client,
  fetchImpl,
} = {}) {
  const circleConfigured = circleGateway?.configuration?.().configured === true;
  const resolvedClient = client ?? (
    config.circleKitKey && circleConfigured
      ? createCircleStablecoinKitClient({
        kitKey: config.circleKitKey,
        apiBaseUrl: config.circleApiBaseUrl,
        walletGateway: circleGateway,
        fetchImpl,
      })
      : null
  );
  return new CircleAppKitGateway({ config, client: resolvedClient });
}

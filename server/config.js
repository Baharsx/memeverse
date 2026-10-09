import { resolve } from 'node:path';
import { z } from 'zod';
import { resolveArcNetwork } from '../src/arc-networks.js';

const emptyToUndefined = (value) => (value === '' ? undefined : value);

/**
 * APP_ORIGIN is compared byte for byte against the browser Origin header, so a configured
 * trailing slash, path, query, or credential would silently break media uploads.
 */
export function canonicalizeAppOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`APP_ORIGIN must be an absolute http(s) origin, received "${value}".`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`APP_ORIGIN must use http or https, received "${url.protocol}".`);
  }
  if (url.username || url.password) {
    throw new Error('APP_ORIGIN must not contain credentials.');
  }
  if (url.search || url.hash) {
    throw new Error('APP_ORIGIN must not contain a query string or fragment.');
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new Error(`APP_ORIGIN must not contain a path, received "${url.pathname}".`);
  }
  return url.origin;
}

const environmentSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  APP_ORIGIN: z.string().min(1).default('http://127.0.0.1:5173'),
  ARC_NETWORK: z.preprocess(emptyToUndefined, z.enum(['mainnet', 'testnet']).optional()),
  VITE_ARC_NETWORK: z.preprocess(emptyToUndefined, z.enum(['mainnet', 'testnet']).optional()),
  ARC_CHAIN_ID: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  VITE_ARC_CHAIN_ID: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  ARC_RPC_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  ARC_FALLBACK_RPC_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  ARC_WALLET_RPC_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  ARC_EXPLORER_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  DATABASE_URL: z.string().url().optional(),
  MEDIA_STORAGE_DIR: z.string().min(1).default('.data/media'),
  // Read only so a mainnet process refuses to boot if someone turns the removed agent back on.
  // The value never enables a payout path. There is no payout path.
  AGENT_AUTONOMOUS_ENABLED: z.enum(['true', 'false']).default('false'),
  TRUSTED_PROXY_HOP_COUNT: z.coerce.number().int().min(0).max(5).default(0),
  MARKET_FACTORY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

function createRateLimits(nodeEnv) {
  if (nodeEnv === 'test') {
    return Object.freeze({ global: 10_000, mediaUpload: 10_000 });
  }
  return Object.freeze({
    global: 240,
    // A signed upload costs a disk write and a chain read.
    mediaUpload: 20,
  });
}

export function loadServerConfig(environment = process.env) {
  const parsed = environmentSchema.parse(environment);
  const network = resolveArcNetwork(environment);
  const mainnet = network.name === 'mainnet';
  if (mainnet && parsed.AGENT_AUTONOMOUS_ENABLED === 'true') {
    throw new Error(
      'AGENT_AUTONOMOUS_ENABLED must be false on Arc mainnet. Autonomous rewards are not live.',
    );
  }
  if (parsed.NODE_ENV === 'production' && !parsed.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when NODE_ENV=production.');
  }

  return Object.freeze({
    port: parsed.API_PORT,
    appOrigin: canonicalizeAppOrigin(parsed.APP_ORIGIN),
    arcNetwork: network.name,
    arcRpcUrl: network.readRpcUrl,
    arcFallbackRpcUrl: network.readFallbackRpcUrl,
    arcWalletRpcUrl: network.walletRpcUrl,
    arcExplorerUrl: network.explorerUrl,
    databaseUrl: parsed.DATABASE_URL,
    // Migrations belonged to the removed settlement tables. The API does not run them.
    runDatabaseMigrations: false,
    mediaStorageDir: resolve(process.cwd(), parsed.MEDIA_STORAGE_DIR),
    // Circle settlement and the agent wallet are gone. These stay false so a leftover env file
    // cannot be read as a configured payout route.
    settlementExecutionConfigured: false,
    settlementOperatorAddress: undefined,
    agentAutonomousEnabled: false,
    circleChainCode: network.circleChainCode,
    circleSettlementContractAddress: undefined,
    agentSettlementContractAddress: undefined,
    agentWalletAddress: undefined,
    marketFactoryAddress: network.factory,
    arcUsdcAddress: network.usdc,
    trustedProxyHopCount: parsed.TRUSTED_PROXY_HOP_COUNT,
    secureCookies: parsed.NODE_ENV === 'production',
    rateLimits: createRateLimits(parsed.NODE_ENV),
    nodeEnv: parsed.NODE_ENV,
    arcChainId: network.chainId,
  });
}

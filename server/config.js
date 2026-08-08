import { resolve } from 'node:path';
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// viem accepts an all-lowercase address because it carries no checksum information. A
// privileged operator address must be unambiguous, so the exact EIP-55 form is required.
const checksummedAddress = z.string().refine((value) => {
  if (!isAddress(value, { strict: true }) || value === ZERO_ADDRESS) return false;
  try {
    return getAddress(value) === value;
  } catch {
    return false;
  }
}, { message: 'must be a checksummed EVM address' });

/**
 * APP_ORIGIN is compared byte for byte against the browser `Origin` header, so a configured
 * trailing slash, path, query, or credential would silently break every privileged request.
 * Canonicalize to a bare scheme://host[:port] and reject anything that is not an origin.
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
  ARC_RPC_URL: z.string().url().default('https://rpc.testnet.arc.io'),
  SETTLEMENT_DATA_FILE: z.string().min(1).default('.data/settlements.json'),
  CIRCLE_NOTIFICATION_DATA_FILE: z.string().min(1).default('.data/circle-notifications.json'),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_MIGRATION_URL: z.string().url().optional(),
  RUN_DATABASE_MIGRATIONS: z.enum(['true', 'false']).default('true'),
  PGLITE_DATA_DIR: z.string().min(1).default('.data/postgres'),
  // Creator media lives on the filesystem rather than in the settlement database: it is
  // presentation, it is content-addressed, and it must never be able to lock or fill the tables
  // that carry money. Production points this at a dedicated directory the unit may write.
  MEDIA_STORAGE_DIR: z.string().min(1).default('.data/media'),
  RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(1000).max(300000).default(5000),
  RECONCILIATION_LEASE_SECONDS: z.coerce.number().int().min(10).max(600).default(30),
  QUOTE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  MAX_SPEND_USDC: z.string().regex(/^\d+(?:\.\d{1,6})?$/).default('25.00'),
  MIN_VIRALITY_SCORE: z.coerce.number().int().min(0).max(100).default(78),
  CREATOR_SHARE_BPS: z.coerce.number().int().min(1).max(10000).default(6000),
  AGENT_DAILY_SPEND_USDC: z.string().regex(/^\d+(?:\.\d{1,6})?$/).default('30.00'),
  AGENT_MAX_FRAUD_RISK: z.coerce.number().int().min(0).max(100).default(20),
  AGENT_MIN_CONFIDENCE: z.coerce.number().int().min(0).max(100).default(80),
  AGENT_SIGNAL_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
  // Autonomous execution. Committed defaults are deliberately production-safe: autonomy is off,
  // the payout envelope is tiny, and the confirmation depth is conservative. A live testnet demo
  // raises these through uncommitted local configuration, never by weakening the defaults here.
  AGENT_AUTONOMOUS_ENABLED: z.enum(['true', 'false']).default('false'),
  AGENT_MIN_CONFIRMATIONS: z.coerce.number().int().min(1).max(2000).default(12),
  AGENT_SIGNAL_LOOKBACK_BLOCKS: z.coerce.number().int().min(10).max(500_000).default(50_000),
  AGENT_AUTONOMOUS_MAX_PAYOUT_USDC: z.string().regex(/^\d+(?:\.\d{1,6})?$/).default('0.100000'),
  AGENT_AUTONOMOUS_MIN_PAYOUT_USDC: z.string().regex(/^\d+(?:\.\d{1,6})?$/).default('0.010000'),
  AGENT_MARKET_DAILY_CAP_USDC: z.string().regex(/^\d+(?:\.\d{1,6})?$/).default('0.300000'),
  AGENT_MARKET_COOLDOWN_SECONDS: z.coerce.number().int().min(60).max(604_800).default(3600),
  AGENT_AUTONOMOUS_SCORE_FLOOR: z.coerce.number().int().min(0).max(99).default(70),
  AGENT_DECISION_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  AGENT_WORKER_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  // Circle Agent Stack. The Agent Wallet is an ERC-4337 smart contract account created with the
  // official Circle CLI; it executes autonomous payouts through its own settlement contract,
  // whose immutable operator is that wallet. Absent values simply leave autonomy unconfigured.
  AGENT_WALLET_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  AGENT_SETTLEMENT_CONTRACT_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  CIRCLE_AGENT_SETTLEMENT_CONTRACT_ID: z.string().uuid().optional(),
  SETTLEMENT_OPERATOR_ADDRESS: checksummedAddress.optional(),
  OPERATOR_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(3600).default(1200),
  OPERATOR_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  OPERATOR_EXECUTION_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(180),
  EXECUTION_CLAIM_LEASE_SECONDS: z.coerce.number().int().min(30).max(600).default(120),
  EXECUTION_CLAIM_HEARTBEAT_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  AUTH_CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  TRUSTED_PROXY_HOP_COUNT: z.coerce.number().int().min(0).max(5).default(0),
  CIRCLE_API_KEY: z.string().min(1).optional(),
  CIRCLE_ENTITY_SECRET: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  CIRCLE_WALLET_SET_ID: z.string().uuid().optional(),
  CIRCLE_WALLET_ID: z.string().uuid().optional(),
  CIRCLE_SETTLEMENT_CONTRACT_ID: z.string().uuid().optional(),
  CIRCLE_SETTLEMENT_DEPLOYMENT_TX_ID: z.string().uuid().optional(),
  CIRCLE_SETTLEMENT_CONTRACT_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  CIRCLE_SETTLEMENT_APPROVAL_TX_ID: z.string().uuid().optional(),
  CIRCLE_MARKET_FACTORY_CONTRACT_ID: z.string().uuid().optional(),
  CIRCLE_MARKET_FACTORY_DEPLOYMENT_TX_ID: z.string().uuid().optional(),
  MARKET_FACTORY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/)
    .default('0x363124490E953EEbB414eB4c3e2f03a40eef8F2C'),
  CIRCLE_SETTLEMENT_ALLOWANCE_USDC: z.string().regex(/^\d+(?:\.\d{1,6})?$/).default('20.00'),
  CIRCLE_API_BASE_URL: z.string().url().default('https://api.circle.com'),
  CIRCLE_FEE_LEVEL: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  CIRCLE_WEBHOOK_KEY_CACHE_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  CIRCLE_WEBHOOK_URL: z.string().url().optional(),
  CIRCLE_KIT_KEY: z.string()
    .regex(/^KIT_KEY:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/)
    .optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

/**
 * Route-class request budgets. Testnet presentation traffic stays comfortable while credential
 * probing, agent decision spam, and Circle-billed estimate spam are individually bounded.
 */
function createRateLimits(nodeEnv) {
  if (nodeEnv === 'test') {
    return Object.freeze({
      global: 10_000, authChallenge: 10_000, authVerify: 10_000, settlementWrite: 10_000,
      settlementExecute: 10_000, appKitEstimate: 10_000, mediaUpload: 10_000,
    });
  }
  return Object.freeze({
    global: 240,
    authChallenge: 12,
    authVerify: 20,
    settlementWrite: 40,
    settlementExecute: 15,
    appKitEstimate: 20,
    // A signed upload costs a disk write and a chain read. Generous enough that a creator can
    // iterate on artwork, tight enough that one wallet cannot fill the volume.
    mediaUpload: 20,
  });
}

export function loadServerConfig(environment = process.env) {
  const parsed = environmentSchema.parse(environment);
  if (parsed.NODE_ENV === 'production' && !parsed.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when NODE_ENV=production.');
  }
  // Privileged Circle settlement execution is only reachable through an authenticated operator
  // session. Production must therefore never boot with execution credentials but no operator.
  const settlementExecutionConfigured = Boolean(
    parsed.CIRCLE_API_KEY && parsed.CIRCLE_ENTITY_SECRET
    && parsed.CIRCLE_WALLET_ID && parsed.CIRCLE_SETTLEMENT_CONTRACT_ADDRESS,
  );
  if (parsed.NODE_ENV === 'production'
    && settlementExecutionConfigured && !parsed.SETTLEMENT_OPERATOR_ADDRESS) {
    throw new Error(
      'SETTLEMENT_OPERATOR_ADDRESS is required when privileged Circle settlement execution is configured.',
    );
  }
  // A heartbeat only protects a live provider call if several beats fit inside one lease. At
  // half the lease a single missed beat would already surrender the claim, so the combination
  // must be rejected at load rather than silently degrade into the race it exists to prevent.
  if (parsed.EXECUTION_CLAIM_HEARTBEAT_SECONDS * 2 >= parsed.EXECUTION_CLAIM_LEASE_SECONDS) {
    throw new Error(
      `EXECUTION_CLAIM_HEARTBEAT_SECONDS (${parsed.EXECUTION_CLAIM_HEARTBEAT_SECONDS}) must be less `
      + `than half of EXECUTION_CLAIM_LEASE_SECONDS (${parsed.EXECUTION_CLAIM_LEASE_SECONDS}).`,
    );
  }

  return Object.freeze({
    port: parsed.API_PORT,
    appOrigin: canonicalizeAppOrigin(parsed.APP_ORIGIN),
    arcRpcUrl: parsed.ARC_RPC_URL,
    dataFile: resolve(process.cwd(), parsed.SETTLEMENT_DATA_FILE),
    circleNotificationDataFile: resolve(process.cwd(), parsed.CIRCLE_NOTIFICATION_DATA_FILE),
    databaseUrl: parsed.DATABASE_URL,
    databaseMigrationUrl: parsed.DATABASE_MIGRATION_URL,
    runDatabaseMigrations: parsed.NODE_ENV !== 'production'
      && parsed.RUN_DATABASE_MIGRATIONS === 'true',
    pgliteDataDir: resolve(process.cwd(), parsed.PGLITE_DATA_DIR),
    mediaStorageDir: resolve(process.cwd(), parsed.MEDIA_STORAGE_DIR),
    reconciliationIntervalMs: parsed.RECONCILIATION_INTERVAL_MS,
    reconciliationLeaseSeconds: parsed.RECONCILIATION_LEASE_SECONDS,
    quoteTtlSeconds: parsed.QUOTE_TTL_SECONDS,
    maxSpendUsdc: parsed.MAX_SPEND_USDC,
    minViralityScore: parsed.MIN_VIRALITY_SCORE,
    creatorShareBps: parsed.CREATOR_SHARE_BPS,
    agentDailySpendUsdc: parsed.AGENT_DAILY_SPEND_USDC,
    agentMaxFraudRisk: parsed.AGENT_MAX_FRAUD_RISK,
    agentMinConfidence: parsed.AGENT_MIN_CONFIDENCE,
    agentSignalMaxAgeSeconds: parsed.AGENT_SIGNAL_MAX_AGE_SECONDS,
    agentAutonomousEnabled: parsed.AGENT_AUTONOMOUS_ENABLED === 'true',
    agentMinConfirmations: parsed.AGENT_MIN_CONFIRMATIONS,
    agentSignalLookbackBlocks: parsed.AGENT_SIGNAL_LOOKBACK_BLOCKS,
    agentAutonomousMaxPayoutUsdc: parsed.AGENT_AUTONOMOUS_MAX_PAYOUT_USDC,
    agentAutonomousMinPayoutUsdc: parsed.AGENT_AUTONOMOUS_MIN_PAYOUT_USDC,
    agentMarketDailyCapUsdc: parsed.AGENT_MARKET_DAILY_CAP_USDC,
    agentMarketCooldownSeconds: parsed.AGENT_MARKET_COOLDOWN_SECONDS,
    agentAutonomousScoreFloor: parsed.AGENT_AUTONOMOUS_SCORE_FLOOR,
    agentDecisionTtlSeconds: parsed.AGENT_DECISION_TTL_SECONDS,
    agentWorkerIntervalMs: parsed.AGENT_WORKER_INTERVAL_MS,
    agentWalletAddress: parsed.AGENT_WALLET_ADDRESS
      ? getAddress(parsed.AGENT_WALLET_ADDRESS) : undefined,
    agentSettlementContractAddress: parsed.AGENT_SETTLEMENT_CONTRACT_ADDRESS
      ? getAddress(parsed.AGENT_SETTLEMENT_CONTRACT_ADDRESS) : undefined,
    circleAgentSettlementContractId: parsed.CIRCLE_AGENT_SETTLEMENT_CONTRACT_ID,
    settlementOperatorAddress: parsed.SETTLEMENT_OPERATOR_ADDRESS
      ? getAddress(parsed.SETTLEMENT_OPERATOR_ADDRESS)
      : undefined,
    settlementExecutionConfigured,
    operatorSessionTtlSeconds: parsed.OPERATOR_SESSION_TTL_SECONDS,
    operatorChallengeTtlSeconds: parsed.OPERATOR_CHALLENGE_TTL_SECONDS,
    operatorExecutionTtlSeconds: parsed.OPERATOR_EXECUTION_TTL_SECONDS,
    executionClaimLeaseSeconds: parsed.EXECUTION_CLAIM_LEASE_SECONDS,
    executionClaimHeartbeatSeconds: parsed.EXECUTION_CLAIM_HEARTBEAT_SECONDS,
    authCleanupIntervalSeconds: parsed.AUTH_CLEANUP_INTERVAL_SECONDS,
    trustedProxyHopCount: parsed.TRUSTED_PROXY_HOP_COUNT,
    secureCookies: parsed.NODE_ENV === 'production',
    rateLimits: createRateLimits(parsed.NODE_ENV),
    nodeEnv: parsed.NODE_ENV,
    arcChainId: 5042002,
    arcUsdcAddress: '0x3600000000000000000000000000000000000000',
    circleApiKey: parsed.CIRCLE_API_KEY,
    circleEntitySecret: parsed.CIRCLE_ENTITY_SECRET,
    circleWalletSetId: parsed.CIRCLE_WALLET_SET_ID,
    circleWalletId: parsed.CIRCLE_WALLET_ID,
    circleSettlementContractId: parsed.CIRCLE_SETTLEMENT_CONTRACT_ID,
    circleSettlementDeploymentTransactionId: parsed.CIRCLE_SETTLEMENT_DEPLOYMENT_TX_ID,
    circleSettlementContractAddress: parsed.CIRCLE_SETTLEMENT_CONTRACT_ADDRESS,
    circleSettlementApprovalTransactionId: parsed.CIRCLE_SETTLEMENT_APPROVAL_TX_ID,
    circleMarketFactoryContractId: parsed.CIRCLE_MARKET_FACTORY_CONTRACT_ID,
    circleMarketFactoryDeploymentTransactionId: parsed.CIRCLE_MARKET_FACTORY_DEPLOYMENT_TX_ID,
    marketFactoryAddress: parsed.MARKET_FACTORY_ADDRESS,
    circleSettlementAllowanceUsdc: parsed.CIRCLE_SETTLEMENT_ALLOWANCE_USDC,
    circleApiBaseUrl: parsed.CIRCLE_API_BASE_URL,
    circleFeeLevel: parsed.CIRCLE_FEE_LEVEL,
    circleWebhookKeyCacheSeconds: parsed.CIRCLE_WEBHOOK_KEY_CACHE_SECONDS,
    circleWebhookUrl: parsed.CIRCLE_WEBHOOK_URL,
    circleKitKey: parsed.CIRCLE_KIT_KEY,
  });
}

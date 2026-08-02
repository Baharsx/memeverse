import { resolve } from 'node:path';
import { z } from 'zod';

const environmentSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  APP_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
  ARC_RPC_URL: z.string().url().default('https://rpc.testnet.arc.io'),
  SETTLEMENT_DATA_FILE: z.string().min(1).default('.data/settlements.json'),
  CIRCLE_NOTIFICATION_DATA_FILE: z.string().min(1).default('.data/circle-notifications.json'),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_MIGRATION_URL: z.string().url().optional(),
  RUN_DATABASE_MIGRATIONS: z.enum(['true', 'false']).default('true'),
  PGLITE_DATA_DIR: z.string().min(1).default('.data/postgres'),
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
  AGENT_ALLOW_MANUAL_DEMO: z.enum(['true', 'false']).default('true'),
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
    .default('0x765E2Eaaba8eaEF4437B15CF42C1F268D3c8c08F'),
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

export function loadServerConfig(environment = process.env) {
  const parsed = environmentSchema.parse(environment);
  if (parsed.NODE_ENV === 'production' && !parsed.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when NODE_ENV=production.');
  }

  return Object.freeze({
    port: parsed.API_PORT,
    appOrigin: parsed.APP_ORIGIN,
    arcRpcUrl: parsed.ARC_RPC_URL,
    dataFile: resolve(process.cwd(), parsed.SETTLEMENT_DATA_FILE),
    circleNotificationDataFile: resolve(process.cwd(), parsed.CIRCLE_NOTIFICATION_DATA_FILE),
    databaseUrl: parsed.DATABASE_URL,
    databaseMigrationUrl: parsed.DATABASE_MIGRATION_URL,
    runDatabaseMigrations: parsed.NODE_ENV !== 'production'
      && parsed.RUN_DATABASE_MIGRATIONS === 'true',
    pgliteDataDir: resolve(process.cwd(), parsed.PGLITE_DATA_DIR),
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
    agentAllowManualDemo: parsed.NODE_ENV !== 'production' && parsed.AGENT_ALLOW_MANUAL_DEMO === 'true',
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

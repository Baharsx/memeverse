import { resolve } from 'node:path';
import { z } from 'zod';

const environmentSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  APP_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
  ARC_RPC_URL: z.string().url().default('https://rpc.testnet.arc.io'),
  SETTLEMENT_DATA_FILE: z.string().min(1).default('.data/settlements.json'),
  CIRCLE_NOTIFICATION_DATA_FILE: z.string().min(1).default('.data/circle-notifications.json'),
  QUOTE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  MAX_SPEND_USDC: z.string().regex(/^\d+(?:\.\d{1,6})?$/).default('25.00'),
  MIN_VIRALITY_SCORE: z.coerce.number().int().min(0).max(100).default(78),
  CREATOR_SHARE_BPS: z.coerce.number().int().min(1).max(10000).default(6000),
  CIRCLE_API_KEY: z.string().min(1).optional(),
  CIRCLE_ENTITY_SECRET: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  CIRCLE_WALLET_SET_ID: z.string().uuid().optional(),
  CIRCLE_WALLET_ID: z.string().uuid().optional(),
  CIRCLE_API_BASE_URL: z.string().url().default('https://api.circle.com'),
  CIRCLE_FEE_LEVEL: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  CIRCLE_WEBHOOK_KEY_CACHE_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  CIRCLE_WEBHOOK_URL: z.string().url().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export function loadServerConfig(environment = process.env) {
  const parsed = environmentSchema.parse(environment);

  return Object.freeze({
    port: parsed.API_PORT,
    appOrigin: parsed.APP_ORIGIN,
    arcRpcUrl: parsed.ARC_RPC_URL,
    dataFile: resolve(process.cwd(), parsed.SETTLEMENT_DATA_FILE),
    circleNotificationDataFile: resolve(process.cwd(), parsed.CIRCLE_NOTIFICATION_DATA_FILE),
    quoteTtlSeconds: parsed.QUOTE_TTL_SECONDS,
    maxSpendUsdc: parsed.MAX_SPEND_USDC,
    minViralityScore: parsed.MIN_VIRALITY_SCORE,
    creatorShareBps: parsed.CREATOR_SHARE_BPS,
    nodeEnv: parsed.NODE_ENV,
    arcChainId: 5042002,
    arcUsdcAddress: '0x3600000000000000000000000000000000000000',
    circleApiKey: parsed.CIRCLE_API_KEY,
    circleEntitySecret: parsed.CIRCLE_ENTITY_SECRET,
    circleWalletSetId: parsed.CIRCLE_WALLET_SET_ID,
    circleWalletId: parsed.CIRCLE_WALLET_ID,
    circleApiBaseUrl: parsed.CIRCLE_API_BASE_URL,
    circleFeeLevel: parsed.CIRCLE_FEE_LEVEL,
    circleWebhookKeyCacheSeconds: parsed.CIRCLE_WEBHOOK_KEY_CACHE_SECONDS,
    circleWebhookUrl: parsed.CIRCLE_WEBHOOK_URL,
  });
}

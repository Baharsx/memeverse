import { resolve } from 'node:path';
import { z } from 'zod';

const environmentSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  APP_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
  ARC_RPC_URL: z.string().url().default('https://rpc.testnet.arc.io'),
  SETTLEMENT_DATA_FILE: z.string().min(1).default('.data/settlements.json'),
  QUOTE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  MAX_SPEND_USDC: z.string().regex(/^\d+(?:\.\d{1,6})?$/).default('25.00'),
  MIN_VIRALITY_SCORE: z.coerce.number().int().min(0).max(100).default(78),
  CREATOR_SHARE_BPS: z.coerce.number().int().min(1).max(10000).default(6000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export function loadServerConfig(environment = process.env) {
  const parsed = environmentSchema.parse(environment);

  return Object.freeze({
    port: parsed.API_PORT,
    appOrigin: parsed.APP_ORIGIN,
    arcRpcUrl: parsed.ARC_RPC_URL,
    dataFile: resolve(process.cwd(), parsed.SETTLEMENT_DATA_FILE),
    quoteTtlSeconds: parsed.QUOTE_TTL_SECONDS,
    maxSpendUsdc: parsed.MAX_SPEND_USDC,
    minViralityScore: parsed.MIN_VIRALITY_SCORE,
    creatorShareBps: parsed.CREATOR_SHARE_BPS,
    nodeEnv: parsed.NODE_ENV,
    arcChainId: 5042002,
  });
}

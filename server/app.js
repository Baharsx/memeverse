import { randomUUID } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { ZodError, z } from 'zod';
import { DomainError } from './domain/errors.js';

const quoteSchema = z.object({
  recipient: z.string().trim().min(1).max(64),
  requestedAmount: z.string().trim().regex(/^\d+(?:\.\d{1,6})?$/),
  viralityScore: z.number().int().min(0).max(100),
  reference: z.string().trim().min(3).max(120),
}).strict();

function responseData(record, metadata = {}) {
  return { data: record, meta: metadata };
}

export function createApp({
  config,
  settlementService,
  arcRpc,
  circleGateway,
  circleWebhookService,
  arcIndexer,
  logger = console,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({
    limit: '32kb',
    verify(request, _response, buffer) {
      request.rawBody = Buffer.from(buffer);
    },
  }));
  app.use(rateLimit({
    windowMs: 60_000,
    limit: config.nodeEnv === 'test' ? 10_000 : 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }));
  app.use((request, response, next) => {
    const requestId = request.get('x-request-id')?.slice(0, 100) || randomUUID();
    request.requestId = requestId;
    response.set('x-request-id', requestId);

    const origin = request.get('origin');
    if (origin === config.appOrigin) {
      response.set('access-control-allow-origin', origin);
      response.set('vary', 'Origin');
      response.set('access-control-allow-headers', 'Content-Type, Idempotency-Key, X-Request-Id');
      response.set('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
    if (request.method === 'OPTIONS') return response.sendStatus(204);

    const startedAt = performance.now();
    response.on('finish', () => {
      logger.info?.(JSON.stringify({
        type: 'http_request',
        requestId,
        method: request.method,
        path: request.path,
        status: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      }));
    });
    next();
  });

  app.get('/api/health', async (_request, response) => {
    const arc = await arcRpc.health();
    response.status(arc.status === 'verified' ? 200 : 503).json({
      status: arc.status === 'verified' ? 'ok' : 'degraded',
      service: 'memeverse-settlement-api',
      arc,
      circle: circleGateway?.configuration() ?? { configured: false, missing: ['CIRCLE_GATEWAY'] },
      settlementContract: arcIndexer?.configuration() ?? { configured: false },
      checkedAt: new Date().toISOString(),
    });
  });

  app.get('/api/v1/config', (_request, response) => {
    response.json({
      data: {
        chainId: config.arcChainId,
        chainCode: 'ARC-TESTNET',
        asset: 'USDC',
        quoteTtlSeconds: config.quoteTtlSeconds,
        policy: {
          maxSpendUsdc: config.maxSpendUsdc,
          minViralityScore: config.minViralityScore,
          creatorShareBps: config.creatorShareBps,
        },
        circle: circleGateway?.configuration() ?? { configured: false },
        settlementContract: arcIndexer?.configuration() ?? { configured: false },
      },
    });
  });

  app.post('/api/v1/settlements/quote', async (request, response) => {
    const idempotencyKey = request.get('idempotency-key');
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new DomainError(
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key header must contain between 8 and 128 characters.',
      );
    }
    const input = quoteSchema.parse(request.body);
    const result = await settlementService.quote(input, idempotencyKey);
    response
      .status(result.replayed ? 200 : 201)
      .json(responseData(result.record, { replayed: result.replayed }));
  });

  app.post('/api/v1/settlements/:id/prepare', async (request, response) => {
    const record = await settlementService.prepare(request.params.id);
    response.json(responseData(record));
  });

  app.post('/api/v1/settlements/:id/execute', async (request, response) => {
    const record = await settlementService.execute(request.params.id);
    response.status(202).json(responseData(record));
  });

  app.post('/api/v1/settlements/:id/reconcile', async (request, response) => {
    const record = await settlementService.reconcile(request.params.id);
    response.json(responseData(record));
  });

  app.get('/api/v1/circle/wallet', async (_request, response) => {
    if (!circleGateway) {
      throw new DomainError('CIRCLE_NOT_CONFIGURED', 'Circle wallet gateway is unavailable.', {
        status: 503,
      });
    }
    const readiness = await circleGateway.readiness();
    response.status(readiness.configured ? 200 : 503).json({ data: readiness });
  });

  app.post('/api/webhooks/circle', async (request, response) => {
    if (!circleWebhookService) {
      throw new DomainError('CIRCLE_WEBHOOK_NOT_CONFIGURED', 'Circle webhook is unavailable.', {
        status: 503,
      });
    }
    const result = await circleWebhookService.handle({
      rawBody: request.rawBody,
      signature: request.get('x-circle-signature'),
      keyId: request.get('x-circle-key-id'),
      payload: request.body,
    });
    response.json({
      received: true,
      replayed: result.replayed,
      outcome: result.receipt.outcome,
    });
  });

  app.get('/api/v1/settlements/:id', async (request, response) => {
    const record = await settlementService.get(request.params.id);
    response.json(responseData(record));
  });

  app.get('/api/v1/settlements', async (_request, response) => {
    const records = await settlementService.list();
    response.json({ data: records, meta: { count: records.length } });
  });

  app.use((_request, _response, next) => {
    next(new DomainError('ROUTE_NOT_FOUND', 'API route was not found.', { status: 404 }));
  });

  app.use((error, request, response, _next) => {
    const known = error instanceof DomainError || error instanceof ZodError;
    const status = error instanceof ZodError ? 400 : known ? error.status : 500;
    const code = error instanceof ZodError ? 'VALIDATION_ERROR' : known ? error.code : 'INTERNAL_ERROR';
    const message = known ? error.message : 'An unexpected server error occurred.';
    const details = error instanceof ZodError ? { issues: error.issues } : error.details;

    logger.error?.(JSON.stringify({
      type: 'api_error',
      requestId: request.requestId,
      code,
      status,
      message: error instanceof Error ? error.message : String(error),
    }));
    response.status(status).json({
      error: { code, message, ...(details ? { details } : {}) },
      requestId: request.requestId,
    });
  });

  return app;
}

import { randomUUID } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { ZodError, z } from 'zod';
import { DomainError } from './domain/errors.js';
import { OPERATOR_SESSION_COOKIE, parseCookies, serializeCookie } from './security/cookies.js';
import { contentSecurityPolicyDirectives } from './security/csp.js';

const quoteSchema = z.object({
  recipient: z.string().trim().min(1).max(64),
  requestedAmount: z.string().trim().regex(/^\d+(?:\.\d{1,6})?$/),
  viralityScore: z.number().int().min(0).max(100),
  reference: z.string().trim().min(3).max(120),
}).strict();

/**
 * A client may submit signal VALUES only. `source`/`provenance`/`observedAt` are deliberately
 * absent: `.strict()` rejects them, so a browser can never claim to be an onchain indexer or an
 * analytics pipeline, and it cannot backdate or postdate evidence.
 */
const agentDecisionSchema = z.object({
  recipient: z.string().trim().min(1).max(64),
  requestedAmount: z.string().trim().regex(/^\d+(?:\.\d{1,6})?$/),
  reference: z.string().trim().min(3).max(120),
  signals: z.object({
    engagementVelocity: z.number().int().min(0).max(100),
    holderRetention: z.number().int().min(0).max(100),
    liquidityDepth: z.number().int().min(0).max(100),
    fraudRisk: z.number().int().min(0).max(100),
    confidence: z.number().int().min(0).max(100),
    sourceReference: z.string().trim().min(3).max(200),
  }).strict(),
}).strict();

const swapEstimateSchema = z.object({
  tokenIn: z.enum(['USDC', 'EURC', 'cirBTC']),
  tokenOut: z.enum(['USDC', 'EURC', 'cirBTC']),
  amountIn: z.string().trim().regex(/^\d+(?:\.\d{1,6})?$/),
}).strict().refine((input) => input.tokenIn !== input.tokenOut, {
  message: 'Swap input and output tokens must differ.',
});

const challengeSchema = z.object({
  address: z.string().trim().min(1).max(64),
}).strict();

const executeSchema = z.object({
  authorizationId: z.string().trim().min(16).max(128),
}).strict();

/**
 * The pause switch takes a reason and nothing else.
 *
 * There is deliberately no field here for a market, a recipient, an amount, or an execution
 * mode: an operator may stop or start autonomy, but the transport offers no vocabulary for
 * approving or steering an individual autonomous payout.
 */
const autonomyControlSchema = z.object({
  paused: z.boolean(),
  reason: z.string().trim().min(1).max(200).optional(),
}).strict();

function responseData(record, metadata = {}) {
  return { data: record, meta: metadata };
}

function requireIdempotencyKey(request) {
  const idempotencyKey = request.get('idempotency-key');
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new DomainError(
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key header must contain between 8 and 128 characters.',
    );
  }
  return idempotencyKey;
}

export function createApp({
  config,
  settlementService,
  arcRpc,
  circleGateway,
  circleWebhookService,
  arcIndexer,
  store,
  agentDecisionService,
  autonomousAgentService,
  autonomyStore,
  appKitGateway,
  operatorAuthService,
  logger = console,
}) {
  const app = express();
  const limits = config.rateLimits ?? {};
  const createLimiter = (limit) => rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Ignoring an untrusted X-Forwarded-For is the intended behaviour here, so the library's
    // misconfiguration warning is only meaningful once a proxy hop count is configured.
    validate: { xForwardedForHeader: config.trustedProxyHopCount > 0 },
  });
  // One shared bucket per route class, so a class budget is not multiplied by its route count.
  const limiter = {
    global: createLimiter(limits.global ?? 240),
    authChallenge: createLimiter(limits.authChallenge ?? 12),
    authVerify: createLimiter(limits.authVerify ?? 20),
    settlementWrite: createLimiter(limits.settlementWrite ?? 40),
    settlementExecute: createLimiter(limits.settlementExecute ?? 15),
    appKitEstimate: createLimiter(limits.appKitEstimate ?? 20),
  };

  app.disable('x-powered-by');
  // An explicit hop count only. `trust proxy: true` would let any client forge X-Forwarded-For
  // and defeat every per-IP limit below.
  if (config.trustedProxyHopCount > 0) app.set('trust proxy', config.trustedProxyHopCount);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: contentSecurityPolicyDirectives({ connectSources: [config.appOrigin] }),
    },
    // Matches the CSP frame-ancestors directive for browsers that only honour the legacy header.
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }));
  app.use(express.json({
    limit: '32kb',
    verify(request, _response, buffer) {
      request.rawBody = Buffer.from(buffer);
    },
  }));
  app.use(limiter.global);
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
    // Deliberately excludes headers, cookies, bodies, wallet signatures, and session tokens.
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

  // A foreign Origin never reaches business logic, on any method. The Circle webhook is
  // exempt because it carries no Origin and is authenticated by signature instead.
  app.use((request, _response, next) => {
    const origin = request.get('origin');
    if (origin && origin !== config.appOrigin && request.path !== '/api/webhooks/circle') {
      return next(new DomainError('CROSS_ORIGIN_BLOCKED', 'Cross-origin requests are not permitted.', {
        status: 403,
      }));
    }
    return next();
  });

  /** Privileged writes and sign-in additionally require a present, exact Origin. */
  function requireOrigin(request, _response, next) {
    if (request.get('origin') !== config.appOrigin) {
      return next(new DomainError(
        'ORIGIN_REQUIRED',
        'This request must originate from the configured application origin.',
        { status: 403 },
      ));
    }
    return next();
  }

  function sessionToken(request) {
    return parseCookies(request.get('cookie')).get(OPERATOR_SESSION_COOKIE);
  }

  function setSessionCookie(response, token, maxAgeSeconds) {
    response.append('set-cookie', serializeCookie(OPERATOR_SESSION_COOKIE, token, {
      maxAgeSeconds,
      secure: config.secureCookies,
      sameSite: 'Strict',
      httpOnly: true,
      path: '/',
    }));
  }

  function clearSessionCookie(response) {
    response.append('set-cookie', serializeCookie(OPERATOR_SESSION_COOKIE, '', {
      maxAgeSeconds: 0,
      secure: config.secureCookies,
      sameSite: 'Strict',
      httpOnly: true,
      path: '/',
    }));
  }

  /**
   * Fails before any privileged business logic runs, so an anonymous caller never learns
   * whether a settlement ID exists.
   */
  async function requireOperator(request, _response, next) {
    try {
      if (!operatorAuthService?.configured) {
        throw new DomainError(
          'OPERATOR_AUTH_REQUIRED',
          'An authenticated MemeVerse settlement operator session is required.',
          { status: 401 },
        );
      }
      const session = await operatorAuthService.authenticate(sessionToken(request));
      if (!session) {
        throw new DomainError(
          'OPERATOR_AUTH_REQUIRED',
          'An authenticated MemeVerse settlement operator session is required.',
          { status: 401 },
        );
      }
      request.operator = session;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  app.get('/api/health', async (_request, response) => {
    const [arc, persistenceReady] = await Promise.all([
      arcRpc.health(),
      store?.health?.() ?? Promise.resolve(true),
    ]);
    const healthy = arc.status === 'verified' && persistenceReady;
    // Public readiness only: no Circle wallet identifiers, no missing-credential inventory.
    response.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      service: 'memeverse-settlement-api',
      arc,
      circle: { ready: circleGateway?.configuration().configured === true },
      settlementContract: { configured: arcIndexer?.configuration().configured === true },
      persistence: { ready: persistenceReady },
      appKit: { runtimeEnabled: appKitGateway?.configuration().runtimeEnabled === true },
      operatorAuth: { configured: operatorAuthService?.configured === true },
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
        circle: { ready: circleGateway?.configuration().configured === true },
        settlementContract: arcIndexer?.configuration() ?? { configured: false },
        agent: {
          dailySpendUsdc: config.agentDailySpendUsdc,
          maxFraudRisk: config.agentMaxFraudRisk,
          minConfidence: config.agentMinConfidence,
          signalMaxAgeSeconds: config.agentSignalMaxAgeSeconds,
          signalProvenance: 'SERVER_ASSIGNED',
          browserProvenance: 'OPERATOR_INPUT',
          executionMode: 'MANUAL_OPERATOR',
          humanApprovalRequired: true,
        },
        operatorAuth: operatorAuthService
          ? { configured: operatorAuthService.configured, ...operatorAuthService.configuration() }
          : { configured: false },
        appKit: appKitGateway?.configuration() ?? { runtimeEnabled: false },
      },
    });
  });

  app.post('/api/v1/auth/challenge', limiter.authChallenge, requireOrigin,
    async (request, response) => {
      if (!operatorAuthService) {
        throw new DomainError('OPERATOR_AUTH_NOT_CONFIGURED', 'Operator authentication is unavailable.', {
          status: 503,
        });
      }
      const { address } = challengeSchema.parse(request.body);
      response.status(201).json({ data: await operatorAuthService.createChallenge(address) });
    });

  app.post('/api/v1/auth/verify', limiter.authVerify, requireOrigin,
    async (request, response) => {
      if (!operatorAuthService) {
        throw new DomainError('OPERATOR_AUTH_NOT_CONFIGURED', 'Operator authentication is unavailable.', {
          status: 503,
        });
      }
      // Validated inside the service so every failure mode returns one generic 401.
      const { token, session } = await operatorAuthService.verify({
        challengeId: request.body?.challengeId,
        signature: request.body?.signature,
      });
      setSessionCookie(response, token, config.operatorSessionTtlSeconds);
      response.json({
        data: {
          authenticated: true,
          operatorAddress: session.address,
          expiresAt: session.expiresAt,
        },
      });
    });

  app.get('/api/v1/auth/session', async (request, response) => {
    const session = operatorAuthService?.configured
      ? await operatorAuthService.authenticate(sessionToken(request)).catch(() => undefined)
      : undefined;
    response.json({
      data: session
        ? { authenticated: true, operatorAddress: session.address, expiresAt: session.expiresAt }
        : { authenticated: false, operatorAddress: null, expiresAt: null },
    });
  });

  app.post('/api/v1/auth/logout', requireOrigin, async (request, response) => {
    await operatorAuthService?.logout(sessionToken(request));
    clearSessionCookie(response);
    response.json({ data: { authenticated: false } });
  });

  app.post('/api/v1/settlements/quote', limiter.settlementWrite, requireOrigin,
    requireOperator, async (request, response) => {
      const idempotencyKey = requireIdempotencyKey(request);
      const input = quoteSchema.parse(request.body);
      const result = await settlementService.quote(input, idempotencyKey);
      response
        .status(result.replayed ? 200 : 201)
        .json(responseData(result.record, { replayed: result.replayed }));
    });

  app.post('/api/v1/agent/decisions', limiter.settlementWrite, requireOrigin,
    requireOperator, async (request, response) => {
      if (!agentDecisionService) {
        throw new DomainError('AGENT_NOT_CONFIGURED', 'Agent decision service is unavailable.', {
          status: 503,
        });
      }
      const idempotencyKey = requireIdempotencyKey(request);
      const input = agentDecisionSchema.parse(request.body);
      const result = await agentDecisionService.decideOperator({
        input,
        operator: { address: request.operator.address, sessionId: request.operator.id },
        idempotencyKey,
      });
      response.status(result.replayed ? 200 : 201).json(
        responseData(result.record, { replayed: result.replayed }),
      );
    });

  app.get('/api/v1/app-kit/capabilities', (_request, response) => {
    response.json({ data: appKitGateway?.configuration() ?? { runtimeEnabled: false } });
  });

  app.post('/api/v1/app-kit/swap/estimate', limiter.appKitEstimate,
    async (request, response) => {
      if (!appKitGateway) {
        throw new DomainError('APP_KIT_NOT_CONFIGURED', 'App Kit gateway is unavailable.', {
          status: 503,
        });
      }
      response.json({ data: await appKitGateway.estimateSwap(swapEstimateSchema.parse(request.body)) });
    });

  app.post('/api/v1/settlements/:id/prepare', limiter.settlementWrite, requireOrigin,
    requireOperator, async (request, response) => {
      const record = await settlementService.prepare(request.params.id);
      response.json(responseData(record));
    });

  app.post('/api/v1/settlements/:id/execution-authorization',
    limiter.settlementExecute, requireOrigin, requireOperator,
    async (request, response) => {
      const record = await settlementService.get(request.params.id);
      if (record.state !== 'AWAITING_SIGNATURE' || !record.policy?.approved) {
        throw new DomainError(
          'SETTLEMENT_NOT_EXECUTABLE',
          `Settlement in ${record.state} state cannot be authorized for execution.`,
          { status: 409, details: { currentState: record.state } },
        );
      }
      const authorization = await operatorAuthService.createExecutionAuthorization({
        session: request.operator,
        settlement: record,
      });
      response.status(201).json({ data: authorization });
    });

  /**
   * Sanitized public view of the autonomous agent.
   *
   * Safe for an unauthenticated browser: it carries policy versions, caps, decision outcomes,
   * and Arc-verifiable identities, but no Circle wallet IDs, no internal worker identity, and
   * no credentials.
   */
  app.get('/api/v1/agent/autonomy', limiter.global, async (request, response) => {
    if (!autonomousAgentService) {
      throw new DomainError('AGENT_NOT_CONFIGURED', 'Autonomous agent is unavailable.', {
        status: 503,
      });
    }
    response.json(responseData(await autonomousAgentService.status()));
  });

  /** Operator-only emergency stop. Never required for an eligible payout to execute. */
  app.post('/api/v1/agent/autonomy', limiter.settlementWrite, requireOrigin, requireOperator,
    async (request, response) => {
      if (!autonomyStore) {
        throw new DomainError('AGENT_NOT_CONFIGURED', 'Autonomous agent is unavailable.', {
          status: 503,
        });
      }
      const { paused, reason } = autonomyControlSchema.parse(request.body);
      const state = await autonomyStore.setAutonomyPaused({
        paused,
        reason: reason ?? null,
        changedBy: request.operator.address,
      });
      response.json(responseData({
        paused: state.paused, reason: state.reason, changedAt: state.changedAt,
      }));
    });

  app.post('/api/v1/settlements/:id/execute', limiter.settlementExecute,
    requireOrigin, requireOperator, async (request, response) => {
      const { authorizationId } = executeSchema.parse(request.body ?? {});
      const record = await settlementService.get(request.params.id);
      // Layer 2: a one-time, expiring approval bound to this exact settlement payload.
      const authority = await operatorAuthService.consumeExecutionAuthorization({
        authorizationId,
        session: request.operator,
        settlement: record,
      });
      const executed = await settlementService.execute(request.params.id, authority);
      response.status(202).json(responseData(executed));
    });

  app.post('/api/v1/settlements/:id/reconcile', limiter.settlementWrite,
    requireOrigin, requireOperator, async (request, response) => {
      const record = await settlementService.reconcile(request.params.id);
      response.json(responseData(record));
    });

  app.get('/api/v1/circle/wallet', requireOperator, async (_request, response) => {
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

  app.get('/api/v1/settlements/:id', requireOperator, async (request, response) => {
    const record = await settlementService.get(request.params.id);
    response.json(responseData(record));
  });

  app.get('/api/v1/settlements', requireOperator, async (_request, response) => {
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

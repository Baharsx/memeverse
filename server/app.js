import { randomUUID } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { DomainError } from './domain/errors.js';
import { readUploadAuthorization } from './domain/media-service.js';
import { contentSecurityPolicyDirectives } from './security/csp.js';
import { ALLOWED_IMAGE_TYPES, normalizeImageMimeType } from '../src/media-authorization.js';

function responseData(record, metadata = {}) {
  return { data: record, meta: metadata };
}

export function createApp({
  config,
  arcRpc,
  mediaService,
  logger = console,
}) {
  const app = express();
  const limits = config.rateLimits ?? {};
  const createLimiter = (limit) => rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    validate: { xForwardedForHeader: config.trustedProxyHopCount > 0 },
  });
  const limiter = {
    global: createLimiter(limits.global ?? 240),
    mediaUpload: createLimiter(limits.mediaUpload ?? 20),
  };

  app.disable('x-powered-by');
  if (config.trustedProxyHopCount > 0) app.set('trust proxy', config.trustedProxyHopCount);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: contentSecurityPolicyDirectives({ connectSources: [config.appOrigin] }),
    },
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
      response.set(
        'access-control-allow-headers',
        'Content-Type, X-Request-Id, X-MemeVerse-Action, X-MemeVerse-Market, '
        + 'X-MemeVerse-Content-Hash, X-MemeVerse-Expires-At, X-MemeVerse-Signature',
      );
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

  app.use((request, _response, next) => {
    const origin = request.get('origin');
    if (origin && origin !== config.appOrigin) {
      return next(new DomainError('CROSS_ORIGIN_BLOCKED', 'Cross-origin requests are not permitted.', {
        status: 403,
      }));
    }
    return next();
  });

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

  app.get('/api/health', async (_request, response) => {
    const [arc, media] = await Promise.all([
      arcRpc.health(),
      mediaService?.readiness() ?? Promise.resolve({ configured: false, status: 'NOT_CONFIGURED' }),
    ]);
    // Media is presentation. A full disk must not make trading look down.
    const healthy = arc.status === 'verified';
    response.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      service: 'memeverse-api',
      arc,
      media,
      checkedAt: new Date().toISOString(),
    });
  });

  const rawImageBody = express.raw({
    type: Object.keys(ALLOWED_IMAGE_TYPES),
    limit: '6mb',
  });

  app.post('/api/v1/media/uploads', limiter.mediaUpload, requireOrigin, rawImageBody,
    async (request, response) => {
      if (!mediaService?.available) {
        throw new DomainError('MEDIA_NOT_AVAILABLE', 'Media uploads are not available.', {
          status: 503,
        });
      }
      const declaredMimeType = normalizeImageMimeType(request.get('content-type'));
      if (!declaredMimeType) {
        throw new DomainError('MEDIA_TYPE_UNSUPPORTED', 'Images must be PNG, JPEG, or WebP.', {
          status: 415,
        });
      }
      const result = await mediaService.authorize({
        bytes: Buffer.isBuffer(request.body) ? request.body : null,
        declaredMimeType,
        ...readUploadAuthorization(request),
      });
      response.status(201).json(responseData(result));
    });

  app.get('/api/v1/media/content/:contentId', async (request, response) => {
    const content = await mediaService?.content(request.params.contentId);
    if (!content) {
      throw new DomainError('MEDIA_NOT_FOUND', 'That image is not available.', { status: 404 });
    }
    response.set('content-type', content.mimeType);
    response.set('cache-control', 'public, max-age=31536000, immutable');
    response.set('content-disposition', 'inline');
    response.set('x-content-type-options', 'nosniff');
    response.send(content.bytes);
  });

  app.get('/api/v1/media/markets', async (request, response) => {
    const requested = String(request.query.markets ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 100);
    response.json(responseData(await mediaService?.marketImages(requested) ?? {}));
  });

  app.use((_request, _response, next) => {
    next(new DomainError('ROUTE_NOT_FOUND', 'API route was not found.', { status: 404 }));
  });

  app.use((error, request, response, _next) => {
    if (error?.type === 'entity.too.large') {
      return response.status(413).json({
        error: { code: 'MEDIA_TOO_LARGE', message: 'Images must be 5 MB or smaller.' },
        requestId: request.requestId,
      });
    }
    if (error?.type === 'entity.parse.failed' || error?.type === 'charset.unsupported'
      || error?.type === 'encoding.unsupported') {
      return response.status(400).json({
        error: { code: 'MALFORMED_BODY', message: 'The request body could not be parsed.' },
        requestId: request.requestId,
      });
    }
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

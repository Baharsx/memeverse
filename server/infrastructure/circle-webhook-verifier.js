import { createPublicKey, verify } from 'node:crypto';
import { DomainError } from '../domain/errors.js';

export class CircleWebhookVerifier {
  constructor({ circleGateway, cacheSeconds, now = () => Date.now() }) {
    this.circleGateway = circleGateway;
    this.cacheMilliseconds = cacheSeconds * 1000;
    this.now = now;
    this.keys = new Map();
  }

  async getKey(keyId) {
    const cached = this.keys.get(keyId);
    if (cached && cached.expiresAt > this.now()) return cached.key;

    const response = await this.circleGateway.getNotificationPublicKey(keyId);
    const key = createPublicKey({
      key: Buffer.from(response.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    this.keys.set(keyId, { key, expiresAt: this.now() + this.cacheMilliseconds });
    return key;
  }

  async assertAuthentic({ rawBody, signature, keyId }) {
    if (!Buffer.isBuffer(rawBody) || !signature || !keyId) {
      throw new DomainError(
        'INVALID_CIRCLE_WEBHOOK_HEADERS',
        'Circle webhook signature headers and raw body are required.',
        { status: 401 },
      );
    }
    let authentic = false;
    try {
      const key = await this.getKey(keyId);
      authentic = verify('sha256', rawBody, key, Buffer.from(signature, 'base64'));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      authentic = false;
    }
    if (!authentic) {
      throw new DomainError('INVALID_CIRCLE_WEBHOOK_SIGNATURE', 'Circle webhook signature is invalid.', {
        status: 401,
      });
    }
  }
}

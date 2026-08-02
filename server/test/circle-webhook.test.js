import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { CircleWebhookService } from '../domain/circle-webhook-service.js';
import { CircleWebhookVerifier } from '../infrastructure/circle-webhook-verifier.js';
import { MemoryNotificationStore } from '../repositories/notification-store.js';

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const gateway = {
    async getNotificationPublicKey() {
      return { algorithm: 'ECDSA_SHA_256', publicKey: keyBase64 };
    },
  };
  let applied = 0;
  const settlementService = {
    async applyCircleNotification(transaction) {
      applied += 1;
      return { matched: true, settlementId: 'settlement-1', state: transaction.state };
    },
  };
  const service = new CircleWebhookService({
    verifier: new CircleWebhookVerifier({ circleGateway: gateway, cacheSeconds: 3600 }),
    notificationStore: new MemoryNotificationStore(),
    settlementService,
  });
  return { privateKey, service, applied: () => applied };
}

function payload() {
  return {
    subscriptionId: 'subscription-1',
    notificationId: 'notification-1',
    notificationType: 'transactions.outbound',
    notification: { id: 'circle-tx-1', state: 'CONFIRMED', blockchain: 'ARC-TESTNET' },
    timestamp: '2026-08-02T10:00:00.000Z',
    version: 2,
  };
}

test('Circle webhook verifies the raw body and deduplicates notificationId', async () => {
  const { privateKey, service, applied } = fixture();
  const body = payload();
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = sign('sha256', rawBody, privateKey).toString('base64');
  const input = { rawBody, signature, keyId: 'key-1', payload: body };

  const first = await service.handle(input);
  const replay = await service.handle(input);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(applied(), 1);
});

test('Circle webhook rejects a modified body', async () => {
  const { privateKey, service } = fixture();
  const body = payload();
  const original = Buffer.from(JSON.stringify(body));
  const signature = sign('sha256', original, privateKey).toString('base64');

  await assert.rejects(service.handle({
    rawBody: Buffer.from(JSON.stringify({ ...body, version: 3 })),
    signature,
    keyId: 'key-1',
    payload: { ...body, version: 3 },
  }), { code: 'INVALID_CIRCLE_WEBHOOK_SIGNATURE', status: 401 });
});

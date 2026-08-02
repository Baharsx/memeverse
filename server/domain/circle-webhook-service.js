import { z } from 'zod';

const transactionSchema = z.object({
  id: z.string().min(1),
  state: z.enum([
    'INITIATED', 'CLEARED', 'QUEUED', 'SENT', 'STUCK',
    'CONFIRMED', 'COMPLETE', 'FAILED', 'DENIED', 'CANCELLED',
  ]),
  blockchain: z.string().optional(),
  destinationAddress: z.string().optional(),
  amounts: z.array(z.string()).optional(),
  txHash: z.string().nullish(),
  walletId: z.string().optional(),
  errorReason: z.string().nullish(),
  errorDetails: z.string().nullish(),
}).passthrough();

const envelopeSchema = z.object({
  subscriptionId: z.string().min(1),
  notificationId: z.string().min(1),
  notificationType: z.string().min(1),
  notification: z.unknown(),
  timestamp: z.string().min(1),
  version: z.literal(2),
}).passthrough();

function extractTransaction(notification) {
  const candidate = notification?.transaction ?? notification;
  return transactionSchema.parse(candidate);
}

export class CircleWebhookService {
  constructor({ verifier, notificationStore, settlementService }) {
    this.verifier = verifier;
    this.notificationStore = notificationStore;
    this.settlementService = settlementService;
  }

  async handle({ rawBody, signature, keyId, payload }) {
    await this.verifier.assertAuthentic({ rawBody, signature, keyId });
    const envelope = envelopeSchema.parse(payload);
    if (envelope.notificationType !== 'transactions.outbound') {
      return this.notificationStore.processOnce(envelope.notificationId, async () => ({
        ignored: true,
        notificationType: envelope.notificationType,
      }));
    }
    const transaction = extractTransaction(envelope.notification);
    return this.notificationStore.processOnce(envelope.notificationId, () => (
      this.settlementService.applyCircleNotification(transaction)
    ));
  }
}

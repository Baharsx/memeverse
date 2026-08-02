import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';

loadLocalEnvironment();
const config = loadServerConfig();

if (!config.circleApiKey || !config.circleEntitySecret || !config.circleWebhookUrl) {
  console.error('CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, and CIRCLE_WEBHOOK_URL are required.');
  process.exitCode = 1;
} else {
  const client = initiateDeveloperControlledWalletsClient({
    apiKey: config.circleApiKey,
    entitySecret: config.circleEntitySecret,
    baseUrl: config.circleApiBaseUrl,
    userAgent: 'MemeVerse-Webhook-Setup/1.2',
  });
  try {
    const subscriptions = await client.listSubscriptions();
    const existing = subscriptions.data?.find(
      (subscription) => subscription.endpoint === config.circleWebhookUrl,
    );
    const subscription = existing
      ?? (await client.createSubscription({ endpoint: config.circleWebhookUrl })).data;
    if (!subscription?.id) throw new Error('Circle did not return a webhook subscription.');
    console.log(`Circle webhook subscription ready: ${subscription.id}`);
    console.log(`Endpoint: ${subscription.endpoint}`);
    console.log('The API verifies X-Circle-Signature before processing and deduplicates notificationId.');
  } catch (error) {
    console.error(`Circle webhook setup failed: ${error?.response?.data?.message ?? error.message}`);
    process.exitCode = 1;
  }
}

import { createApp } from './app.js';
import { loadServerConfig } from './config.js';
import { loadLocalEnvironment } from './load-env.js';
import { ArcRpcClient, assertRpcChainId } from './infrastructure/arc-rpc.js';
import { createMediaStore } from './infrastructure/media-store.js';
import { createMarketResolver } from './infrastructure/market-resolver.js';
import { MediaService } from './domain/media-service.js';
import { createReferralService } from './domain/referral-service.js';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { ActivityIndexer } from './domain/activity-indexer.js';

loadLocalEnvironment();

const config = loadServerConfig();
if (process.env.ARC_SKIP_CHAIN_CHECK !== 'true') {
  await assertRpcChainId({
    rpcUrl: config.arcRpcUrl,
    expectedChainId: config.arcChainId,
    nodeEnv: config.nodeEnv,
  });
}

const arcRpc = new ArcRpcClient({
  rpcUrl: config.arcRpcUrl,
  expectedChainId: config.arcChainId,
});
const mediaService = new MediaService({
  store: createMediaStore(config),
  collector: createMarketResolver(config),
  chainId: config.arcChainId,
});
const referralService = createReferralService({ storageDir: config.mediaStorageDir, chainId: config.arcChainId });
const activityIndexer = new ActivityIndexer({
  publicClient: createPublicClient({ transport: http(config.arcRpcUrl, { retryCount: 0 }) }),
  factories: [config.marketFactoryAddress, config.fractionalFactoryAddress],
  stateFile: join(config.mediaStorageDir, 'activity', 'state.json'),
});
activityIndexer.start();
const app = createApp({ config, arcRpc, mediaService, referralService, activityIndexer });

const server = app.listen(config.port, '127.0.0.1', () => {
  console.info(JSON.stringify({
    type: 'server_started',
    port: config.port,
    chainId: config.arcChainId,
    mediaConfigured: mediaService.available,
  }));
});

async function shutdown(signal) {
  console.info(JSON.stringify({ type: 'server_stopping', signal }));
  activityIndexer.stop();
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

process.on('SIGINT', () => shutdown('SIGINT').catch(console.error));
process.on('SIGTERM', () => shutdown('SIGTERM').catch(console.error));

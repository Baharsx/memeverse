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
import { RewardsService } from './domain/rewards-service.js';

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
// The treasury receives the platform fee; it never earns a share of it.
const rewardsService = new RewardsService({ indexer: activityIndexer, storageDir: config.mediaStorageDir });
for (const factory of [config.marketFactoryAddress, config.fractionalFactoryAddress].filter(Boolean)) {
  activityIndexer.publicClient.readContract({ address: factory, abi: [{ type: 'function', name: 'treasury', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }], functionName: 'treasury' })
    .then((treasury) => { if (!rewardsService.exclude.includes(treasury)) rewardsService.exclude.push(treasury); })
    .catch((error) => console.warn(JSON.stringify({ type: 'treasury_lookup_failed', message: String(error?.message).slice(0, 200) })));
}
const app = createApp({ config, arcRpc, mediaService, referralService, activityIndexer, rewardsService });

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

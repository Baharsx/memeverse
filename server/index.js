import { createApp } from './app.js';
import { loadServerConfig } from './config.js';
import { createSettlementPolicy } from './domain/policy.js';
import { SettlementService } from './domain/settlement-service.js';
import { ArcRpcClient } from './infrastructure/arc-rpc.js';
import { JsonSettlementStore } from './repositories/settlement-store.js';

try {
  process.loadEnvFile?.('.env');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const config = loadServerConfig();
const store = new JsonSettlementStore(config.dataFile);
await store.initialize();

const policy = createSettlementPolicy(config);
const settlementService = new SettlementService({
  store,
  policy,
  chainId: config.arcChainId,
  quoteTtlSeconds: config.quoteTtlSeconds,
});
const arcRpc = new ArcRpcClient({
  rpcUrl: config.arcRpcUrl,
  expectedChainId: config.arcChainId,
});
const app = createApp({ config, settlementService, arcRpc });
const server = app.listen(config.port, '127.0.0.1', () => {
  console.info(JSON.stringify({
    type: 'server_started',
    port: config.port,
    chainId: config.arcChainId,
    dataFile: config.dataFile,
  }));
});

function shutdown(signal) {
  console.info(JSON.stringify({ type: 'server_stopping', signal }));
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

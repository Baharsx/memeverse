import { loadServerConfig } from './config.js';
import { loadLocalEnvironment } from './load-env.js';
import { createPostgresSettlementStore } from './repositories/postgres-settlement-store.js';

loadLocalEnvironment();
const config = loadServerConfig();
const store = createPostgresSettlementStore({
  ...config,
  databaseUrl: config.databaseMigrationUrl ?? config.databaseUrl,
});
try {
  await store.initialize({ migrate: true });
  console.info(JSON.stringify({ type: 'database_migrated' }));
} finally {
  await store.close?.();
}

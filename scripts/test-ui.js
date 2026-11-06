import { spawnSync } from 'node:child_process';
import { build } from 'vite';

// A separate test build leaves the normal deployment bundle and local configuration intact.
Object.assign(process.env, {
  VITE_ARC_NETWORK: 'testnet',
  VITE_ARC_CHAIN_ID: '5042002',
  VITE_ARC_RPC_URL: 'https://rpc.testnet.arc.io',
  VITE_ARC_FALLBACK_RPC_URL: 'https://rpc.drpc.testnet.arc.io',
  VITE_MEMEVERSE_FACTORY_ADDRESS: '0x363124490E953EEbB414eB4c3e2f03a40eef8F2C',
  VITE_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  VITE_REOWN_PROJECT_ID: '',
  VITE_API_BASE_URL: '',
});
await build({ base: '/memeverse/', build: { outDir: 'cache/ui-dist' }, logLevel: 'error' });
const result = spawnSync(process.execPath, ['--test', 'tests/ui.test.js'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;

import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';

loadLocalEnvironment();
const config = loadServerConfig();

if (!config.circleApiKey || !config.circleEntitySecret || !config.circleWalletId) {
  console.error('CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, and CIRCLE_WALLET_ID are required.');
  process.exitCode = 1;
} else {
  const client = initiateDeveloperControlledWalletsClient({
    apiKey: config.circleApiKey,
    entitySecret: config.circleEntitySecret,
    baseUrl: config.circleApiBaseUrl,
    userAgent: 'MemeVerse-Faucet/1.2',
  });
  try {
    const response = await client.getWallet({ id: config.circleWalletId });
    const wallet = response.data?.wallet;
    if (!wallet || wallet.blockchain !== 'ARC-TESTNET') {
      throw new Error('Configured Circle wallet is not on ARC-TESTNET.');
    }
    await client.requestTestnetTokens({
      address: wallet.address,
      blockchain: 'ARC-TESTNET',
      usdc: true,
    });
    console.log(`Arc Testnet USDC faucet request accepted for ${wallet.address}.`);
    console.log('Run the API and check GET /api/v1/circle/wallet until the balance updates.');
  } catch (error) {
    console.error(`Circle faucet request failed: ${error?.response?.data?.message ?? error.message}`);
    process.exitCode = 1;
  }
}

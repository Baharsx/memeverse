import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';
import { circleIdempotencyKey } from './circle-idempotency.js';

loadLocalEnvironment();
const config = loadServerConfig();

if (!config.circleApiKey || !config.circleEntitySecret) {
  console.error('Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET in .env.local.');
  process.exitCode = 1;
} else {
  const client = initiateDeveloperControlledWalletsClient({
    apiKey: config.circleApiKey,
    entitySecret: config.circleEntitySecret,
    baseUrl: config.circleApiBaseUrl,
    userAgent: 'MemeVerse-Setup/1.2',
  });

  try {
    let walletSetId = config.circleWalletSetId;
    if (!walletSetId) {
      const response = await client.createWalletSet({
        idempotencyKey: circleIdempotencyKey('wallet-set-create', ['MemeVerse Arc Settlement']),
        name: 'MemeVerse Arc Settlement',
      });
      walletSetId = response.data?.walletSet?.id;
    }
    if (!walletSetId) throw new Error('Circle did not return a wallet set ID.');

    let wallet;
    if (config.circleWalletId) {
      const response = await client.getWallet({ id: config.circleWalletId });
      wallet = response.data?.wallet;
    } else {
      const response = await client.createWallets({
        idempotencyKey: circleIdempotencyKey('wallet-create', [
          'ARC-TESTNET', 'EOA', 1, walletSetId, 'memeverse-arc-settlement',
        ]),
        blockchains: ['ARC-TESTNET'],
        accountType: 'EOA',
        count: 1,
        walletSetId,
        metadata: [{ name: 'MemeVerse Settlement EOA', refId: 'memeverse-arc-settlement' }],
      });
      wallet = response.data?.wallets?.[0];
    }
    if (!wallet) throw new Error('Circle did not return an Arc wallet.');
    if (wallet.blockchain !== 'ARC-TESTNET' || wallet.accountType !== 'EOA') {
      throw new Error('Circle wallet is not the required ARC-TESTNET EOA.');
    }

    console.log('Circle Arc Testnet wallet is ready. Add these non-secret IDs to .env.local:');
    console.log(`CIRCLE_WALLET_SET_ID=${walletSetId}`);
    console.log(`CIRCLE_WALLET_ID=${wallet.id}`);
    console.log(`Wallet address: ${wallet.address}`);
    console.log('After saving both IDs, run npm run circle:fund to request Arc Testnet USDC.');
  } catch (error) {
    console.error(`Circle setup failed: ${error?.response?.data?.message ?? error.message}`);
    process.exitCode = 1;
  }
}

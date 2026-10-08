import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { circleChain } from '../../scripts/circle-chain.js';
import {
  MIN_BALANCE_WEI,
  RESERVE_WEI,
  SEED_MARKET,
  assertMainnetChainId,
  bufferedGasCost,
  deployBudgetDecision,
  factoryConstructorArgs,
  parseDeployerPrivateKey,
} from '../../scripts/mainnet-deploy-plan.js';
import { assertBrowserReadChain } from '../../src/boot-chain.js';

test('deploy budget keeps 0.15 USDC and refuses an empty mainnet wallet', () => {
  assert.equal(deployBudgetDecision({
    balanceWei: 0n,
    estimatedCostWei: 1n,
  }).action, 'unfunded');
  assert.equal(deployBudgetDecision({
    balanceWei: MIN_BALANCE_WEI - 1n,
    estimatedCostWei: 0n,
  }).action, 'unfunded');
  assert.equal(deployBudgetDecision({
    balanceWei: MIN_BALANCE_WEI,
    estimatedCostWei: MIN_BALANCE_WEI,
  }).action, 'abort');
  assert.equal(deployBudgetDecision({
    balanceWei: 10n ** 18n,
    estimatedCostWei: 10n ** 17n,
  }).action, 'deploy');
  assert.equal(deployBudgetDecision({
    balanceWei: RESERVE_WEI,
    estimatedCostWei: 1n,
    phase: 'next',
  }).action, 'abort');
  assert.equal(deployBudgetDecision({
    balanceWei: RESERVE_WEI + 1n,
    estimatedCostWei: 1n,
    phase: 'next',
  }).action, 'deploy');
  assert.equal(bufferedGasCost(1000n, 20n), 25_000n);
});

test('mainnet chain id guard rejects Archie 1243 and testnet 5042002', () => {
  assert.equal(assertMainnetChainId(5042), 5042);
  assert.equal(assertMainnetChainId(5042n), 5042);
  assert.throws(() => assertMainnetChainId(1243), /Archie Chain/);
  assert.throws(() => assertMainnetChainId(5042002), /expected 5042/);
});

test('the deployer key parser never echoes the value', () => {
  const key = `0x${'ab'.repeat(32)}`;
  assert.equal(parseDeployerPrivateKey(`  "${key}"  `), key);
  assert.throws(() => parseDeployerPrivateKey('secret-value-not-a-key'), (error) => {
    assert.equal(error.message.includes('secret-value-not-a-key'), false);
    assert.match(error.message, /was not printed/);
    return true;
  });
});

test('factory constructor args match the 6A.1 exact-spend shape', () => {
  const treasury = '0x1111111111111111111111111111111111111111';
  assert.deepEqual(
    factoryConstructorArgs('0x3600000000000000000000000000000000000000', treasury),
    ['0x3600000000000000000000000000000000000000', treasury, 100, 100],
  );
  assert.equal(SEED_MARKET.name, 'MEMEVERSE GENESIS');
  assert.equal(SEED_MARKET.symbol, 'MMV');
  assert.equal(SEED_MARKET.description.includes('Arc Public Testnet'), false);
  assert.equal(SEED_MARKET.description.toLowerCase().includes('autonomous rewards are live'), false);
  assert.match(SEED_MARKET.description, /settle inside the trade/);
});

test('circleChain refuses mainnet before any blockchain code ARC is returned', () => {
  assert.throws(
    () => circleChain({ arcNetwork: 'mainnet', arcChainId: 5042, circleChainCode: null }),
    /Circle is not used on Arc mainnet/,
  );
  assert.throws(
    () => circleChain({ arcNetwork: 'testnet', arcChainId: 5042, circleChainCode: 'ARC-TESTNET' }),
    /Circle is not used on Arc mainnet/,
  );
  assert.throws(
    () => circleChain({ arcNetwork: 'testnet', arcChainId: 5042002, circleChainCode: 'ARC' }),
    /Circle is not used on Arc mainnet/,
  );
  assert.deepEqual(
    circleChain({
      arcNetwork: 'testnet',
      arcChainId: 5042002,
      circleChainCode: 'ARC-TESTNET',
      arcExplorerUrl: 'https://testnet.arcscan.app',
    }),
    {
      chainId: 5042002,
      blockchain: 'ARC-TESTNET',
      explorer: 'https://testnet.arcscan.app',
      label: 'Arc Testnet',
    },
  );
});

test('deploy and circle scripts do not print the key or return Circle chain ARC', async () => {
  const deploy = await readFile('scripts/deploy-arc-mainnet-eoa.js', 'utf8');
  const circle = await readFile('scripts/circle-chain.js', 'utf8');
  const webhook = await readFile('scripts/circle-webhook-setup.js', 'utf8');
  assert.equal(/console\.(log|error|info|debug)\(\s*(privateKey|account)\b/.test(deploy), false);
  assert.equal(/\$\{privateKey\}/.test(deploy), false);
  assert.equal(/console\.(log|error|info|debug)\([^)\n]*DEPLOYER_PRIVATE_KEY/.test(deploy), false);
  assert.equal(circle.includes("blockchain: 'ARC'"), false);
  assert.ok(webhook.indexOf('circleChain(config)') < webhook.indexOf('initiateDeveloperControlledWalletsClient('));
  assert.equal(deploy.includes('5042'), true);
});

test('browser boot aborts unless the read RPC is chain 5042', async () => {
  let calls = 0;
  const fetchImplementation = async () => {
    calls += 1;
    throw new Error('fetch must not run');
  };
  assert.equal(await assertBrowserReadChain({ enabled: false, fetchImplementation }), null);
  assert.equal(calls, 0);

  const ok = await assertBrowserReadChain({
    enabled: true,
    expectedChainId: 5042,
    urls: ['https://rpc.example'],
    fetchImplementation: async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1, result: '0x13b2',
    })),
  });
  assert.equal(ok, 5042);

  await assert.rejects(
    () => assertBrowserReadChain({
      enabled: true,
      expectedChainId: 5042,
      urls: ['https://rpc.example', 'https://fallback.example'],
      fetchImplementation: async () => new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, result: '0x4cef52',
      })),
    }),
    /reported chain 5042002/,
  );
  await assert.rejects(
    () => assertBrowserReadChain({
      enabled: true,
      expectedChainId: 5042,
      urls: ['https://rpc.example'],
      fetchImplementation: async () => new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, result: '0x4db',
      })),
    }),
    /reported chain 1243/,
  );
  await assert.rejects(
    () => assertBrowserReadChain({
      enabled: true,
      expectedChainId: 5042,
      urls: ['https://primary.example', 'https://fallback.example'],
      fetchImplementation: async () => {
        throw new Error('offline');
      },
    }),
    /chain check failed/,
  );
});

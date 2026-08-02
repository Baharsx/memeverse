import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArcRpcClient } from '../infrastructure/arc-rpc.js';
import { JsonSettlementStore } from '../repositories/settlement-store.js';

function record(overrides = {}) {
  return {
    id: 'record-1',
    idempotencyKey: 'persistence-key-1',
    createdAt: '2026-08-02T10:00:00.000Z',
    state: 'PREPARED',
    history: [],
    ...overrides,
  };
}

test('JSON store survives a new process instance and writes versioned data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-store-'));
  const file = join(directory, 'settlements.json');
  try {
    const firstStore = new JsonSettlementStore(file);
    await firstStore.initialize();
    await firstStore.createIfAbsent(record());
    await firstStore.update(record({ state: 'AWAITING_SIGNATURE' }));

    const secondStore = new JsonSettlementStore(file);
    await secondStore.initialize();
    const restored = await secondStore.get('record-1');
    const raw = JSON.parse(await readFile(file, 'utf8'));

    assert.equal(restored.state, 'AWAITING_SIGNATURE');
    assert.equal(raw.version, 1);
    assert.equal(raw.settlements.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('JSON store serializes concurrent creation by idempotency key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-store-race-'));
  const file = join(directory, 'settlements.json');
  try {
    const store = new JsonSettlementStore(file);
    await store.initialize();
    const [first, second] = await Promise.all([
      store.createIfAbsent(record({ id: 'record-a' })),
      store.createIfAbsent(record({ id: 'record-b' })),
    ]);

    assert.equal(Number(first.created) + Number(second.created), 1);
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Arc RPC health verifies chain and block in parallel responses', async () => {
  const client = new ArcRpcClient({
    rpcUrl: 'https://rpc.invalid',
    expectedChainId: 5042002,
    fetchImplementation: async (_url, options) => {
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: request.method === 'eth_chainId' ? '0x4cef52' : '0x2a',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const health = await client.health();
  assert.equal(health.status, 'verified');
  assert.equal(health.chainId, 5042002);
  assert.equal(health.blockNumber, 42);
});

test('Arc RPC health fails closed on a different chain', async () => {
  const client = new ArcRpcClient({
    rpcUrl: 'https://rpc.invalid',
    expectedChainId: 5042002,
    fetchImplementation: async (_url, options) => {
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: request.method === 'eth_chainId' ? '0x1' : '0x2a',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const health = await client.health();
  assert.equal(health.status, 'degraded');
  assert.match(health.reason, /Expected Arc chain 5042002/);
});

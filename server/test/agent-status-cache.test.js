import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PublicStatusCache } from '../domain/public-status-cache.js';

/**
 * The public agent status cache.
 *
 * It exists so a judge does not watch "READING AGENT STATUS…" through several timed-out polls.
 * That convenience is only acceptable while three things stay true: it can never claim an agent
 * is active after it has stopped being active, it can never be reached by anything that moves
 * money, and it can never outlive a short bound.
 */

function controllableClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('a fresh entry is served without repeating the expensive read', async () => {
  const clock = controllableClock();
  const cache = new PublicStatusCache({ ttlMs: 15_000, clock: clock.now });
  let loads = 0;
  const load = async () => { loads += 1; return { state: 'ACTIVE', n: loads }; };

  assert.deepEqual(await cache.read(load), { state: 'ACTIVE', n: 1 });
  clock.advance(14_999);
  assert.deepEqual(await cache.read(load), { state: 'ACTIVE', n: 1 });
  assert.equal(loads, 1, 'the second read inside the window must not reload');
});

test('an entry is never served past its TTL', async () => {
  const clock = controllableClock();
  const cache = new PublicStatusCache({ ttlMs: 15_000, clock: clock.now });
  let value = 'ACTIVE';
  const load = async () => ({ state: value });

  assert.deepEqual(await cache.read(load), { state: 'ACTIVE' });
  clock.advance(15_000);
  value = 'PAUSED';
  assert.deepEqual(await cache.read(load), { state: 'PAUSED' }, 'expiry must reload');
});

test('a paused agent replaces a cached ACTIVE once the window passes', async () => {
  const clock = controllableClock();
  const cache = new PublicStatusCache({ ttlMs: 15_000, clock: clock.now });
  let paused = false;
  const load = async () => ({ paused, executor: { state: paused ? 'PAUSED' : 'LIVE' } });

  assert.equal((await cache.read(load)).executor.state, 'LIVE');
  paused = true;
  // Within the window the previous answer is still served — bounded, and by design.
  assert.equal((await cache.read(load)).executor.state, 'LIVE');
  clock.advance(15_001);
  assert.equal((await cache.read(load)).executor.state, 'PAUSED', 'the stop must surface');
  assert.equal((await cache.read(load)).paused, true);
});

test('an unavailable wallet session replaces a cached ACTIVE once the window passes', async () => {
  const clock = controllableClock();
  const cache = new PublicStatusCache({ ttlMs: 10_000, clock: clock.now });
  let sessionValid = true;
  const load = async () => ({ executor: { state: sessionValid ? 'LIVE' : 'UNAVAILABLE' } });

  assert.equal((await cache.read(load)).executor.state, 'LIVE');
  sessionValid = false;
  clock.advance(10_001);
  assert.equal((await cache.read(load)).executor.state, 'UNAVAILABLE');
});

test('a failed read is never cached and never masks a later failure', async () => {
  const clock = controllableClock();
  const cache = new PublicStatusCache({ ttlMs: 15_000, clock: clock.now });

  await assert.rejects(() => cache.read(async () => { throw new Error('circle down'); }), /circle down/);
  // A failure must not leave a stale entry behind, and must not be remembered as a value.
  let loads = 0;
  const ok = async () => { loads += 1; return { state: 'ACTIVE' }; };
  assert.deepEqual(await cache.read(ok), { state: 'ACTIVE' });
  assert.equal(loads, 1, 'the next caller performs a real read');

  // A failure after a success also propagates rather than resurrecting the old value.
  clock.advance(15_001);
  await assert.rejects(() => cache.read(async () => { throw new Error('still down'); }), /still down/);
});

test('a stale entry is never served as a fallback when a refresh fails', async () => {
  const clock = controllableClock();
  const cache = new PublicStatusCache({ ttlMs: 5_000, clock: clock.now });
  assert.deepEqual(await cache.read(async () => ({ state: 'ACTIVE' })), { state: 'ACTIVE' });
  clock.advance(5_001);
  // The tempting behaviour — "serve the old value, it is better than an error" — would keep
  // showing ACTIVE for an agent that may have stopped. It must not happen.
  await assert.rejects(() => cache.read(async () => { throw new Error('down'); }), /down/);
});

test('concurrent misses share one read instead of multiplying the work', async () => {
  const clock = controllableClock();
  const cache = new PublicStatusCache({ ttlMs: 15_000, clock: clock.now });
  let loads = 0;
  const load = async () => {
    loads += 1;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    return { state: 'ACTIVE', n: loads };
  };
  const results = await Promise.all([cache.read(load), cache.read(load), cache.read(load)]);
  assert.equal(loads, 1, 'three simultaneous viewers must cost one read');
  for (const result of results) assert.deepEqual(result, { state: 'ACTIVE', n: 1 });
});

test('the TTL is bounded and must be positive', () => {
  assert.throws(() => new PublicStatusCache({ ttlMs: 0 }), /positive TTL/);
  assert.throws(() => new PublicStatusCache({ ttlMs: -1 }), /positive TTL/);
  assert.throws(() => new PublicStatusCache({ ttlMs: Number.NaN }), /positive TTL/);
  // A presentation cache must not be allowed to become a claim about the agent.
  assert.throws(() => new PublicStatusCache({ ttlMs: 60_001 }), /must not exceed 60 seconds/);
  assert.doesNotThrow(() => new PublicStatusCache({ ttlMs: 60_000 }));
});

test('invalidate drops the entry so an operator stop is visible at once', async () => {
  const clock = controllableClock();
  const cache = new PublicStatusCache({ ttlMs: 30_000, clock: clock.now });
  let paused = false;
  const load = async () => ({ paused });

  assert.deepEqual(await cache.read(load), { paused: false });
  paused = true;
  cache.invalidate();
  assert.deepEqual(await cache.read(load), { paused: true }, 'no waiting for the TTL');
});

test('no financial path can reach the presentation cache', async () => {
  const { readdir } = await import('node:fs/promises');
  async function walk(directory) {
    const found = [];
    let entries;
    try {
      entries = await readdir(fileURLToPath(new URL(directory, import.meta.url)), { withFileTypes: true });
    } catch { return found; }
    for (const entry of entries) {
      const next = `${directory}/${entry.name}`;
      if (entry.isDirectory()) found.push(...await walk(next));
      else if (entry.name.endsWith('.js')) found.push(next);
    }
    return found;
  }
  const files = (await Promise.all(['../domain', '../infrastructure', '../repositories', '../../scripts'].map(walk)))
    .flat().filter((path) => !path.includes('public-status-cache.js'));

  for (const path of files) {
    const text = await source(path);
    assert.equal(text.includes('PublicStatusCache'), false,
      `${path} must not import the presentation cache`);
  }
  // The worker process in particular.
  const worker = await source('../worker.js');
  assert.equal(worker.includes('PublicStatusCache'), false, 'the worker must never read cached status');

  // Exactly one construction site, in the transport layer, wired to the public route only.
  const app = await source('../app.js');
  assert.equal((app.match(/new PublicStatusCache/g) ?? []).length, 1);
  assert.ok(app.includes('agentStatusCache.read(() => autonomousAgentService.status())'),
    'the cache wraps only the public status assembly');
  assert.ok(app.includes('agentStatusCache.invalidate()'), 'an operator pause clears it immediately');
});

test('the executor reads are issued concurrently rather than one after the other', async () => {
  const gateway = await source('../infrastructure/circle-agent-wallet-gateway.js');
  // Two independent CLI subprocesses; awaiting them in sequence is what pushed the public status
  // past the browser timeout. Their values and failure behaviour are unchanged.
  assert.ok(/const \[status, balances\] = await Promise\.all\(\[/.test(gateway),
    'wallet status and balance are read together');
  assert.equal(
    /const status = await this\.#cli\(\['wallet', 'status'\][\s\S]{0,400}const balances = await this\.#cli/.test(gateway),
    false,
    'the two reads must not be sequential again',
  );
});

test('the browser gives the agent status enough time to finish one read', async () => {
  const api = await source('../../src/api.js');
  const fn = api.slice(api.indexOf('export async function getAgentAutonomy'));
  const timeout = /AbortSignal\.timeout\((\d[\d_]*)\)/.exec(fn);
  assert.ok(timeout, 'the agent status call sets its own deadline');
  const ms = Number(timeout[1].replace(/_/g, ''));
  // Comfortably beyond the measured cold path, so a slow read completes instead of aborting and
  // starting another cold read.
  assert.ok(ms >= 15_000, `agent status timeout ${ms}ms must clear the measured cold path`);
  assert.ok(ms <= 30_000, `agent status timeout ${ms}ms must still fail eventually`);

  // Every other call keeps the tighter default.
  assert.ok(api.includes('AbortSignal.timeout(8000)'), 'the general default is unchanged');
});

test('the configured cache window is short and cannot be set unbounded', async () => {
  const { loadServerConfig } = await import('../config.js');
  const base = { NODE_ENV: 'test' };
  assert.equal(loadServerConfig(base).agentStatusCacheMs, 15_000);
  assert.equal(loadServerConfig({ ...base, AGENT_STATUS_CACHE_MS: '5000' }).agentStatusCacheMs, 5000);
  assert.throws(() => loadServerConfig({ ...base, AGENT_STATUS_CACHE_MS: '60001' }));
  assert.throws(() => loadServerConfig({ ...base, AGENT_STATUS_CACHE_MS: '-1' }));
});

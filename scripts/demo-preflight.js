#!/usr/bin/env node
import { createPublicClient, http } from 'viem';
import { loadLocalEnvironment } from '../server/load-env.js';

/**
 * Read-only demo readiness check.
 *
 * Run this before presenting. It answers one question — "will the demo path work right now?" —
 * and it answers it by reading, never by writing. There is no transaction here, no deployment, no
 * funding call, and no privileged settlement execution. Running it a hundred times changes
 * nothing onchain and costs nothing.
 *
 * It also never prints a secret. A credential is reported as CONFIGURED or NOT CONFIGURED and its
 * value is never read into the output, because a preflight is exactly the kind of thing somebody
 * pastes into a chat window ten minutes before a demo.
 */

const ARC_CHAIN_ID = 5042002;
const DEFAULT_RPC = 'https://rpc.testnet.arc.io';
const FALLBACK_RPC = 'https://rpc.drpc.testnet.arc.io';

/**
 * Contracts the demo path actually touches. Addresses that live in committed source are pinned
 * here; addresses that are deployment configuration are read from the environment, so an
 * unconfigured deployment reports NOT CONFIGURED instead of checking somebody else's contract.
 */
const PINNED = Object.freeze({
  'ARC USDC': '0x3600000000000000000000000000000000000000',
  'MARKET FACTORY': '0x363124490E953EEbB414eB4c3e2f03a40eef8F2C',
});

export const CHECK_STATES = Object.freeze({
  PASS: 'PASS',
  WARN: 'WARN',
  FAIL: 'FAIL',
  SKIP: 'SKIP',
});

/** One aligned output row: `LABEL ..... STATE  detail`. */
export function formatCheckLine({ label, state, detail }, width = 26) {
  const dots = '.'.repeat(Math.max(1, width - label.length));
  return `${label} ${dots} ${state}${detail ? `  ${detail}` : ''}`;
}

/**
 * The verdict. Any FAIL blocks the demo; a WARN is a degraded surface the presenter should know
 * about but can route around. Reporting "ready" while something failed would defeat the point.
 */
export function overallVerdict(checks) {
  if (checks.some((check) => check.state === CHECK_STATES.FAIL)) return 'NOT READY';
  if (checks.some((check) => check.state === CHECK_STATES.WARN)) return 'READY WITH WARNINGS';
  return 'READY';
}

/** Reports presence only. The value is never returned, logged, or compared against a literal. */
export function describeConfigured(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? 'CONFIGURED'
    : 'NOT CONFIGURED';
}

function check(label, state, detail = '') {
  return { label, state, detail };
}

async function checkRpc(client, label) {
  try {
    const [chainId, blockNumber] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
    ]);
    if (chainId !== ARC_CHAIN_ID) {
      return check(label, CHECK_STATES.FAIL, `wrong chain ${chainId}, expected ${ARC_CHAIN_ID}`);
    }
    return check(label, CHECK_STATES.PASS, `chain ${chainId} / block ${blockNumber}`);
  } catch (error) {
    return check(label, CHECK_STATES.FAIL, shortReason(error));
  }
}

async function checkBytecode(client, label, address) {
  if (!address) return check(label, CHECK_STATES.WARN, 'not configured in this environment');
  try {
    const code = await client.getCode({ address });
    if (!code || code === '0x') {
      return check(label, CHECK_STATES.FAIL, `no bytecode at ${address}`);
    }
    return check(label, CHECK_STATES.PASS, `${(code.length - 2) / 2} bytes / ${address}`);
  } catch (error) {
    return check(label, CHECK_STATES.FAIL, shortReason(error));
  }
}

async function checkBackend(origin) {
  try {
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(6000),
      headers: { accept: 'application/json' },
    });
    const payload = await response.json().catch(() => null);
    const detail = `${payload?.status ?? response.status} / arc ${payload?.arc?.status ?? 'unknown'}`;
    return response.ok
      ? check('BACKEND API', CHECK_STATES.PASS, detail)
      : check('BACKEND API', CHECK_STATES.WARN, `degraded — ${detail}`);
  } catch {
    // Not running is a warning, not a failure: the preflight is often run before starting it.
    return check('BACKEND API', CHECK_STATES.WARN, 'not reachable — start `npm run dev:api`');
  }
}

async function checkDatabase(databaseUrl) {
  if (!databaseUrl) {
    return check('DATABASE', CHECK_STATES.WARN, 'DATABASE_URL unset');
  }
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    // A trivially cheap read. Nothing is created, altered, or migrated by this script.
    await client.query('SELECT 1');
    return check('DATABASE', CHECK_STATES.PASS, 'reachable');
  } catch (error) {
    return check('DATABASE', CHECK_STATES.FAIL, shortReason(error));
  } finally {
    await client.end().catch(() => undefined);
  }
}

function shortReason(error) {
  const message = error?.shortMessage ?? error?.message ?? String(error);
  return message.split('\n')[0].slice(0, 90);
}

export async function runPreflight(environment = process.env) {
  const rpcUrl = environment.ARC_RPC_URL?.trim() || DEFAULT_RPC;
  const client = createPublicClient({ transport: http(rpcUrl) });
  const fallbackClient = createPublicClient({
    transport: http(environment.ARC_FALLBACK_RPC_URL?.trim() || FALLBACK_RPC),
  });

  const checks = [];
  checks.push(await checkRpc(client, 'ARC RPC'));
  checks.push(await checkRpc(fallbackClient, 'ARC RPC FALLBACK'));

  for (const [label, address] of Object.entries(PINNED)) {
    checks.push(await checkBytecode(client, label, address));
  }
  checks.push(await checkBytecode(client, 'MEDIA NFT', environment.MEDIA_NFT_ADDRESS));
  checks.push(await checkBytecode(client, 'NFT MARKETPLACE', environment.NFT_MARKETPLACE_ADDRESS));
  checks.push(await checkBytecode(client, 'USDC VAULT', environment.USDC_VAULT_ADDRESS));

  const viteMissing = ['VITE_MEDIA_NFT_ADDRESS', 'VITE_NFT_MARKETPLACE_ADDRESS', 'VITE_USDC_VAULT_ADDRESS']
    .filter((name) => !environment[name]);
  checks.push(check(
    'FRONTEND ENV',
    viteMissing.length === 0 ? CHECK_STATES.PASS : CHECK_STATES.WARN,
    viteMissing.length === 0 ? 'all VITE_ contract addresses present' : `missing ${viteMissing.join(', ')}`,
  ));

  checks.push(await checkDatabase(environment.DATABASE_URL));
  checks.push(await checkBackend(
    (environment.PREFLIGHT_API_ORIGIN ?? environment.APP_ORIGIN ?? 'http://127.0.0.1:8787').replace(/\/$/, ''),
  ));

  return checks;
}

/* c8 ignore start — the CLI wrapper; the logic above is what the tests exercise. */
if (import.meta.url === `file://${process.argv[1]}`) {
  loadLocalEnvironment();
  const checks = await runPreflight();
  const verdict = overallVerdict(checks);
  console.info('\nDEMO PREFLIGHT');
  console.info('─'.repeat(64));
  for (const item of checks) console.info(formatCheckLine(item));
  console.info('─'.repeat(64));
  console.info(verdict === 'READY' ? '\nDEMO READY ✅\n' : `\nDEMO ${verdict}\n`);
  process.exitCode = verdict === 'NOT READY' ? 1 : 0;
}
/* c8 ignore stop */

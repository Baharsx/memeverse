/**
 * Arc read-transport concurrency check.
 *
 * A sequential `eth_chainId` proves an endpoint is alive. It does not prove it can serve a
 * MemeVerse page. One Markets load fans out to roughly ninety concurrent calls, and the release
 * that had to be rolled back passed every sequential check while answering 90 of 95 concurrent
 * calls with HTTP 429 — the Markets page died with ARC RPC READ FAILED. This is the check that
 * would have caught it.
 *
 * Deliberately NOT part of `npm test`. It talks to public Arc infrastructure, and CI must not
 * hammer someone else's endpoints on every push. Run it by hand before changing a read endpoint:
 *
 *     npm run rpc:burst:check
 *
 * It is bounded: one burst per endpoint, a fixed request count, a timeout, and then it stops.
 */
import { ARC_READ_FALLBACK_RPC_URL, ARC_READ_RPC_URL, ARC_WALLET_RPC_URL } from '../src/arc.js';

const BURST = Number(process.env.RPC_BURST_SIZE ?? 95); // one Markets page load
const TIMEOUT_MS = 15_000;
// Anything below this and a Markets page cannot render, because viem's fallback has nowhere to go.
const PASS_RATIO = 0.95;

async function burst(url) {
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: BURST }, async (_, index) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: index, method: 'eth_blockNumber', params: [] }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (response.status === 429) return 'rateLimited';
      if (!response.ok) return `http${response.status}`;
      // A 200 carrying a JSON-RPC error is still a failed read.
      if (/"error"/.test(text)) return /rate limit/i.test(text) ? 'rateLimited' : 'rpcError';
      return 'ok';
    } catch (error) {
      return error.name === 'AbortError' ? 'timeout' : 'network';
    } finally {
      clearTimeout(timer);
    }
  }));

  const tally = {};
  for (const outcome of results) tally[outcome] = (tally[outcome] ?? 0) + 1;
  return { tally, ok: tally.ok ?? 0, ms: Date.now() - started };
}

const targets = [
  ['APPLICATION READ / primary ', ARC_READ_RPC_URL, true],
  ['APPLICATION READ / fallback', ARC_READ_FALLBACK_RPC_URL, true],
  // Reported for information. A wallet holds this endpoint and makes its own occasional calls
  // through it; it never serves a Markets page, so it is not required to survive this burst.
  ['WALLET REGISTRATION        ', ARC_WALLET_RPC_URL, false],
];

console.log(`\nARC RPC BURST CHECK — ${BURST} concurrent eth_blockNumber per endpoint`);
console.log('─'.repeat(78));

let failed = false;
for (const [label, url, required] of targets) {
  const { tally, ok, ms } = await burst(url);
  const ratio = ok / BURST;
  const verdict = required ? (ratio >= PASS_RATIO ? 'PASS' : 'FAIL') : 'INFO';
  if (verdict === 'FAIL') failed = true;
  console.log(
    `${label}  ${verdict.padEnd(5)} ${String(ok).padStart(3)}/${BURST} ok  ${String(ms).padStart(5)}ms  ${JSON.stringify(tally)}`,
  );
  console.log(`${' '.repeat(29)}${url}`);
}

console.log('─'.repeat(78));
if (failed) {
  console.log('\nFAIL — an application read endpoint cannot serve a Markets page under concurrency.');
  console.log('Do not ship it as a read transport, however healthy it looks sequentially.\n');
  process.exit(1);
}
console.log('\nPASS — both application read endpoints survive a Markets-page burst.\n');

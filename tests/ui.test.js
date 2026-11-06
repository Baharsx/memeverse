import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';
import { factoryAbi, marketAbi, usdcAbi } from '../src/market.js';

// Browser fixtures only. No wallet signing, external RPC or financial operations are permitted.
const MARKET = '0x1111111111111111111111111111111111111111';
const IMPORTED = '0x2222222222222222222222222222222222222222';
const USDC = '0x3600000000000000000000000000000000000000';
const multicall = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
const abi = [...factoryAbi, ...marketAbi, ...usdcAbi, ...multicall];
let browser;
let server;
let origin;

before(async () => {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname.replace(/^\/memeverse\/?/, '');
    const relative = path.extname(pathname) ? pathname : 'index.html';
    try {
      const body = await readFile(new URL(`../cache/ui-dist/${relative}`, import.meta.url));
      response.writeHead(200, { 'content-type': types[path.extname(relative)] ?? 'application/octet-stream' });
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}/memeverse`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function fixture({ width = 390, reducedMotion = 'no-preference', empty = false, delay = 0, offline = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion });
  context.setDefaultTimeout(10_000);
  const calls = { marketCount: 0, quoteBuy: [], quoteSell: [] };
  const connection = { offline };
  const errors = [];
  function readCall(data, target) {
    const { functionName: name, args } = decodeFunctionData({ abi, data });
    let result;
    if (name === 'aggregate3') {
      result = args[0].map((call) => ({ success: true, returnData: readCall(call.callData, call.target) }));
    } else {
      if (name === 'marketCount') calls.marketCount++;
      if (name === 'quoteBuy') calls.quoteBuy.push(args[0]);
      if (name === 'quoteSell') calls.quoteSell.push(args[0]);
      const values = {
        marketCount: empty ? 0n : 1n, markets: MARKET, isMarket: String(args?.[0] ?? '').toLowerCase() !== IMPORTED,
        name: target?.toLowerCase() === IMPORTED ? 'Imported Meme' : 'Pixel Possum', symbol: 'PXPS',
        description: 'Browser test fixture', creator: MARKET, treasury: MARKET, usdc: USDC,
        totalSupplyTokens: 1000000n, soldTokenCount: 100n, reserveUsdc: 1000000n,
        creatorFeesPaidUsdc: 10000n, treasuryFeesPaidUsdc: 10000n,
        creatorFeeBps: 100n, treasuryFeeBps: 100n, basePriceUsdc: 100n, slopePriceUsdc: 1000n,
        createdAt: 1700000000n, createdBlock: 100n, deployedAtBlock: 10n,
        active: true, spotPriceUsdc: 100n, balanceOf: 0n, allowance: 0n,
        quoteBuy: [10n ** 18n, 100n, 1n, 1n, 102n], quoteSell: [98n, 100n, 1n, 1n],
      };
      assert.ok(name in values, `unhandled RPC fixture: ${name}`);
      result = values[name];
    }
    return encodeFunctionResult({ abi, functionName: name, result });
  }
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' } });
    if (url.pathname.startsWith('/api/')) {
      return route.fulfill({ json: { data: {}, status: 'ok', arc: { status: 'verified' } } });
    }
    if (request.method() === 'POST') {
      const payload = request.postDataJSON();
      if (payload?.jsonrpc || Array.isArray(payload)) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        function respond(item) {
          if (connection.offline) return { jsonrpc: '2.0', id: item.id, error: { code: -32000, message: 'Fixture RPC unavailable' } };
          let result;
          if (item.method === 'eth_chainId') result = '0x4cef52';
          else if (item.method === 'eth_blockNumber') result = '0x100';
          else if (item.method === 'eth_call') result = readCall(item.params[0].data, item.params[0].to);
          else throw new Error(`Unexpected RPC method ${item.method}`);
          return { jsonrpc: '2.0', id: item.id, result };
        }
        return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: Array.isArray(payload) ? payload.map(respond) : respond(payload) });
      }
    }
    if (url.origin !== new URL(origin).origin) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, calls, errors, connection };
}

test('all product routes fit mobile, tablet and desktop, including narrow screens', async () => {
  for (const width of [320, 390, 768, 1024, 1440]) {
    const { context, page, errors } = await fixture({ width });
    try {
      for (const route of ['/', '/markets', '/launch', '/referral', '/campaigns', '/missing']) {
        await page.goto(origin + route);
        await page.locator('h1').waitFor();
        if (route === '/') {
          await page.waitForFunction(() => {
            const art = document.querySelector('.hero-art img');
            return art?.complete && art.naturalWidth > 0;
          });
        }
        const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        assert.ok(size.scroll <= size.width, `${route} overflows at ${width}px: ${size.scroll}`);
        assert.ok(await page.locator('.site-header .wallet').isVisible());
        assert.ok((await page.locator('.site-header .wallet').boundingBox()).height >= 44);
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test('home and market navigation reuse reads and move keyboard focus to the new page', async () => {
  const { context, page, calls } = await fixture();
  try {
    await page.goto(origin + '/');
    await page.locator('.carousel-card').filter({ hasText: 'Pixel Possum' }).waitFor();
    const reads = calls.marketCount;
    assert.equal(reads, 1, 'home and ticker should share the initial RPC read');
    await page.locator('.site-header nav a[href$="/markets"]').click();
    await page.locator('.market-card-body strong').waitFor();
    assert.equal(calls.marketCount, reads, 'navigation should use fresh cached markets');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'main-content');
    assert.equal(await page.locator('.site-header nav a[aria-current="page"]').textContent(), '02MARKETS');
    await page.locator('input[type="search"]').fill('does not exist');
    await page.locator('input[type="search"]').press('Enter');
    assert.equal(await page.getByText('Paste a 20-byte Arc contract address.').count(), 0, 'search Enter must not submit the import form');
    await page.getByRole('button', { name: 'CLEAR FILTERS' }).click();
    await page.locator('.market-card-body strong').waitFor();
    await page.goBack();
    await page.locator('.hero').waitFor();
    assert.match(await page.title(), /A meme becomes a market/);
  } finally { await context.close(); }
});

test('trade sheet traps focus, restores its trigger, and debounces only the active quote', async () => {
  const { context, page, calls, errors } = await fixture();
  try {
    await page.goto(origin + '/markets');
    const buy = page.locator('.market-card-actions').getByRole('button', { name: 'BUY', exact: true });
    await buy.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await page.waitForFunction(() => document.querySelector('.trade-review')?.textContent.includes('1 PXPS'));
    assert.equal(calls.quoteBuy.length, 1);
    assert.equal(calls.quoteSell.length, 0, 'hidden sell side must not fetch a quote');
    const amount = dialog.locator('input[type="number"]');
    await amount.fill('0.02');
    await amount.fill('0.03');
    await amount.fill('0.04');
    assert.ok(await dialog.getByText('Updating your buy quote…').isVisible());
    assert.ok(await dialog.getByRole('button', { name: 'SIGN BUY ON ARC' }).isDisabled());
    await page.waitForFunction(() => !document.querySelector('.quote-feedback'));
    assert.deepEqual(calls.quoteBuy, [10000n, 40000n], 'intermediate keystrokes must not hit the RPC');
    assert.equal(await page.locator('#root').evaluate((node) => node.inert), true);
    const focusable = dialog.locator('button:not(:disabled), a[href], input:not(:disabled)');
    await focusable.last().focus();
    await page.keyboard.press('Tab');
    assert.equal(await focusable.first().evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focusable.last().evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(await buy.evaluate((node) => node === document.activeElement), true);
    assert.equal(await page.locator('#root').evaluate((node) => node.inert), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('import opens the freshly read market even when a search previously hid every card', async () => {
  const { context, page } = await fixture();
  try {
    await page.goto(origin + '/markets');
    await page.locator('.market-card-body strong').waitFor();
    await page.locator('input[type="search"]').fill('no match');
    await page.locator('.market-import input').fill(IMPORTED);
    await page.getByRole('button', { name: 'IMPORT →' }).click();
    await page.getByRole('dialog').waitFor();
    assert.match(await page.locator('#trade-modal-title').textContent(), /Imported Meme/);
    await page.waitForTimeout(350);
    assert.equal(await page.getByRole('dialog').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('input[type="search"]').inputValue(), '');
    await page.reload();
    await page.locator('.market-card-body strong').filter({ hasText: 'Imported Meme' }).waitFor();
  } finally { await context.close(); }
});

test('loading and empty states are distinct, and reduced motion disables the ticker', async () => {
  const { context, page } = await fixture({ empty: true, delay: 500, reducedMotion: 'reduce' });
  try {
    await page.goto(origin + '/markets');
    await page.locator('.market-skeleton').first().waitFor();
    assert.equal(await page.locator('.market-empty').count(), 0);
    await page.getByText('No markets yet', { exact: true }).waitFor();
    const motion = await page.locator('.marquee div').evaluate((node) => getComputedStyle(node).animationName);
    assert.equal(motion, 'none');
  } finally { await context.close(); }
});

test('an RPC failure offers retry instead of claiming there are no markets', async () => {
  const { context, page, connection } = await fixture({ offline: true });
  try {
    await page.goto(origin + '/markets');
    await page.getByText('Couldn’t reach Arc.', { exact: false }).waitFor();
    assert.equal(await page.locator('.market-empty').count(), 0);
    connection.offline = false;
    await page.getByRole('button', { name: 'TRY AGAIN', exact: true }).click();
    await page.locator('.market-card-body strong').waitFor();
    assert.equal(await page.locator('.inline-error').count(), 0);
  } finally { await context.close(); }
});

test('connecting a wallet inside the trade sheet preserves the chosen market', async () => {
  const { context, page, errors } = await fixture({ delay: 100 });
  await page.addInitScript(() => {
    let connected = false;
    window.ethereum = {
      on() {}, removeListener() {},
      async request({ method }) {
        if (method === 'eth_chainId') return '0x4cef52';
        if (method === 'eth_requestAccounts') connected = true;
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return connected ? ['0x3333333333333333333333333333333333333333'] : [];
        if (method === 'wallet_requestPermissions') { connected = true; return [{ parentCapability: 'eth_accounts' }]; }
        throw new Error(`Unexpected wallet request: ${method}`);
      },
    };
  });
  try {
    await page.goto(origin + '/markets');
    await page.locator('.market-card-actions').getByRole('button', { name: 'BUY', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect a wallet' }).click();
    await page.getByText('Reading your wallet balances and allowances…').waitFor();
    assert.match(await page.locator('#trade-modal-title').textContent(), /Pixel Possum/);
    assert.ok(await page.getByRole('button', { name: 'SIGN BUY ON ARC' }).isDisabled());
    await page.getByRole('dialog').getByRole('button', { name: 'APPROVE MAX', exact: false }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.quote-feedback'));
    assert.equal(await page.getByRole('dialog').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

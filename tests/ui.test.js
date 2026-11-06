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

async function fixture({ width = 390, reducedMotion = 'no-preference', empty = false, delay = 0, offline = false, held = 0n, total = 1 } = {}) {
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
        marketCount: empty ? 0n : BigInt(total), markets: `0x${(BigInt(MARKET) + (typeof args?.[0] === 'bigint' ? args[0] : 0n)).toString(16).padStart(40, '0')}`, isMarket: String(args?.[0] ?? '').toLowerCase() !== IMPORTED,
        name: target?.toLowerCase() === IMPORTED ? 'Imported Meme' : 'Pixel Possum', symbol: 'PXPS',
        description: 'Browser test fixture', creator: MARKET, treasury: MARKET, usdc: USDC,
        totalSupplyTokens: 1000000n, soldTokenCount: 100n, reserveUsdc: 1000000n,
        creatorFeesPaidUsdc: 10000n, treasuryFeesPaidUsdc: 10000n,
        creatorFeeBps: 100n, treasuryFeeBps: 100n, basePriceUsdc: 100n, slopePriceUsdc: 1000n,
        createdAt: 1700000000n, createdBlock: 100n, deployedAtBlock: 10n,
        active: true, spotPriceUsdc: 100n, balanceOf: held, allowance: 0n,
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
    if (url.pathname === '/api/v1/referrals/invite') return route.fulfill({ json: { data: { code: 'aB3_kD9-zX2q', chainId: 5042002 } } });
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
    assert.equal(await page.locator('.market-import').count(), 0);
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
    assert.equal(await amount.inputValue(), '1');
    assert.equal(await dialog.locator('.trade-details').evaluate((node) => node.open), false);
    assert.equal(await dialog.getByLabel('Estimated tokens received').inputValue(), '1');
    await amount.fill('0.02');
    await amount.fill('0.03');
    await amount.fill('0.04');
    assert.ok(await dialog.getByText('Updating your buy quote…').isVisible());
    assert.ok(await dialog.getByRole('button', { name: 'SIGN BUY ON ARC' }).isDisabled());
    await page.waitForFunction(() => !document.querySelector('.quote-feedback'));
    assert.deepEqual(calls.quoteBuy, [1000000n, 40000n], 'intermediate keystrokes must not hit the RPC');
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

test('wallet connection preserves the trade, separates positions and creates a private invite', async () => {
  const { context, page, errors } = await fixture({ delay: 100, held: 10n ** 18n });
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
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.market-import').count(), 0);
    await page.getByLabel('YOUR MARKETS').selectOption('created');
    await page.getByText('No markets match your filters', { exact: true }).waitFor();
    await page.getByLabel('YOUR MARKETS').selectOption('held');
    await page.locator('.market-card-body strong').waitFor();
    await page.locator('.site-header nav a[href$="/referral"]').click();
    await page.waitForFunction(() => document.querySelector('#referral-link')?.value.includes('aB3_kD9-zX2q'));
    const link = await page.locator('#referral-link').inputValue();
    assert.equal(link.includes('0x'), false);
    assert.ok(new URL(link).searchParams.get('ref').length === 12);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('market-card hover and return interpolate gently instead of jumping', async () => {
  const { context, page } = await fixture({ width: 1440 });
  try {
    await page.goto(origin + '/markets');
    const card = page.locator('.market-card').first();
    await card.waitFor();
    const offset = () => card.evaluate((node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).m42);
    await card.hover();
    await page.waitForTimeout(70);
    const rising = await offset();
    assert.ok(rising < 0 && rising > -3.9, `hover should be in motion, got ${rising}`);
    await page.waitForTimeout(550);
    assert.ok(Math.abs((await offset()) + 4) < .1);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(70);
    const falling = await offset();
    assert.ok(falling < 0 && falling > -3.9, `return should be in motion, got ${falling}`);
  } finally { await context.close(); }
});

test('hover keeps the carousel border inside its viewport and trade units stay readable', async () => {
  const { context, page } = await fixture({ width: 1440, reducedMotion: 'reduce' });
  try {
    await page.goto(origin + '/');
    const card = page.locator('.carousel-card').filter({ hasText: 'Pixel Possum' });
    await card.hover();
    const bounds = await card.evaluate((node) => ({
      top: node.getBoundingClientRect().top,
      viewportTop: node.closest('.carousel-track').getBoundingClientRect().top,
    }));
    assert.ok(bounds.top >= bounds.viewportTop + 1, 'hover must not clip the top border');
    await page.locator('.site-header nav a[href$="/markets"]').click();
    await page.locator('.market-card-actions').getByRole('button', { name: 'BUY', exact: true }).click();
    const unit = page.getByRole('dialog').locator('.market-order form > label small').first();
    const metrics = await unit.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const input = node.parentElement.querySelector('input').getBoundingClientRect();
      return { size: parseFloat(getComputedStyle(node).fontSize), right: bounds.right, inputRight: input.right, center: bounds.top + bounds.height / 2, inputCenter: input.top + input.height / 2 };
    });
    assert.ok(metrics.size >= 14, 'USDC must be readable');
    assert.ok(metrics.right <= metrics.inputRight - 12, 'the unit needs breathing room inside the input');
    assert.ok(Math.abs(metrics.center - metrics.inputCenter) <= 2, 'the unit should be centered vertically');
  } finally { await context.close(); }
});

test('launch previews form values and requires artwork picked through the preview card', async () => {
  const { context, page } = await fixture({ width: 1440 });
  const uploads = [];
  page.on('request', (request) => { if (request.url().includes('/media/uploads')) uploads.push(request.url()); });
  try {
    await page.goto(origin + '/launch');
    await page.getByLabel('MEME NAME', { exact: true }).fill('Happy Pixel');
    await page.getByLabel('TICKER', { exact: true }).fill('happy');
    await page.getByLabel('DESCRIPTION', { exact: true }).fill('A cheerful community meme.');
    await page.getByLabel('STARTING PRICE (USDC)', { exact: true }).fill('0.012');
    const preview = page.getByRole('complementary', { name: 'Live token preview' });
    assert.equal(await preview.locator('h2').textContent(), 'Happy Pixel');
    assert.ok((await preview.textContent()).includes('$HAPPY'));
    assert.ok((await preview.textContent()).includes('0.012 USDC'));
    assert.ok((await preview.textContent()).includes('A cheerful community meme.'));
    await page.getByRole('button', { name: 'REVIEW ONCHAIN LAUNCH' }).click();
    assert.equal(await page.getByRole('region', { name: 'Launch review' }).count(), 0);
    await page.getByText('Choose a token image using the preview card before continuing.').waitFor();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload token image' }).click();
    await (await chooser).setFiles('public/memeverse-hero-v1-640.webp');
    await page.waitForFunction(() => document.querySelector('.launch-artwork-picker img')?.getAttribute('src')?.startsWith('blob:'));
    assert.equal(await page.locator('.form-grid form .image-picker').count(), 0);
    assert.equal(await page.locator('#launch-market-image').isVisible(), false);
    const photo = await page.locator('.launch-artwork-picker').boundingBox();
    const upload = await page.getByRole('button', { name: 'Upload token image' }).boundingBox();
    assert.ok(upload.y >= photo.y + photo.height, 'upload button should be below the photo');
    await page.getByRole('button', { name: 'REVIEW ONCHAIN LAUNCH' }).click();
    await page.getByRole('region', { name: 'Launch review' }).waitFor();
    assert.deepEqual(uploads, [], 'picking an image must not upload before a confirmed market');
  } finally { await context.close(); }
});

test('market carousel scrolls slowly, pauses on hover, and offers an explicit pause control', async () => {
  const { context, page } = await fixture({ width: 1440, total: 6 });
  try {
    await page.goto(origin + '/');
    const track = page.locator('.carousel-track');
    await page.waitForFunction(() => document.querySelectorAll('.carousel-card').length === 6);
    await track.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    const before = await track.evaluate((node) => node.scrollLeft);
    await page.waitForTimeout(900);
    const after = await track.evaluate((node) => node.scrollLeft);
    assert.ok(after - before > 3 && after - before < 20, `expected a gentle scroll, got ${after - before}px`);
    await page.locator('.carousel-card').nth(1).hover();
    const hovered = await track.evaluate((node) => node.scrollLeft);
    await page.waitForTimeout(400);
    assert.ok(Math.abs((await track.evaluate((node) => node.scrollLeft)) - hovered) <= 1);
    await page.getByRole('button', { name: 'Pause automatic scrolling' }).click();
    await page.mouse.move(0, 0);
    const paused = await track.evaluate((node) => node.scrollLeft);
    await page.waitForTimeout(400);
    assert.ok(Math.abs((await track.evaluate((node) => node.scrollLeft)) - paused) <= 1);
    assert.equal(await page.getByRole('button', { name: 'Resume automatic scrolling' }).count(), 1);
    assert.equal((await page.locator('.marquee').textContent()).includes('READING'), false);
  } finally { await context.close(); }
});

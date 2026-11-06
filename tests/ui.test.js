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

async function fixture({ width = 390, reducedMotion = 'no-preference', empty = false, delay = 0, offline = false, held = 0n, total = 1, artwork = false, mediaDelay = 0, imageDelay = 0, imageFailure = false, highPrice = false, fractional = false, activity = null } = {}) {
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
        totalSupplyTokens: 1000000n, soldTokenCount: 100n, soldTokenUnits: 100500000000000000000n, tradingVersion: fractional ? 2n : 1n, reserveUsdc: 1000000n,
        creatorFeesPaidUsdc: 10000n, treasuryFeesPaidUsdc: 10000n,
        creatorFeeBps: 100n, treasuryFeeBps: 100n, basePriceUsdc: 100n, slopePriceUsdc: 1000n,
        createdAt: 1700000000n, createdBlock: 100n, deployedAtBlock: 10n,
        active: true, spotPriceUsdc: highPrice ? 1000000n : 100n, balanceOf: held, allowance: 0n,
        quoteBuy: fractional ? [980392156862745098n, 980393n, 9803n, 9803n, 999999n] : highPrice ? (args?.[0] < 1020000n ? [0n, 0n, 0n, 0n, 0n] : [10n ** 18n, 1000000n, 10000n, 10000n, 1020000n]) : [10n ** 18n, 100n, 1n, 1n, 102n], quoteSell: [98n, 100n, 1n, 1n],
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
    if (url.pathname === '/api/v1/media/markets') {
      if (mediaDelay) await new Promise((resolve) => setTimeout(resolve, mediaDelay));
      const addresses = (url.searchParams.get('markets') ?? '').split(',').filter(Boolean);
      return route.fulfill({ json: { data: artwork ? Object.fromEntries(addresses.map((address) => [address, { url: '/api/v1/media/content/ticker-image.webp' }])) : {} } });
    }
    if (url.pathname === '/api/v1/media/content/ticker-image.webp') {
      if (imageDelay) await new Promise((resolve) => setTimeout(resolve, imageDelay));
      return imageFailure ? route.fulfill({ status: 404 }) : route.fulfill({ contentType: 'image/webp', body: await readFile('public/memeverse-hero-v1-640.webp') });
    }
    if (url.pathname === '/api/v1/activity' && activity) return route.fulfill({ json: { data: activity } });
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
            const images = [...document.querySelectorAll('.hero-art img, .hero-headline-art img')];
            return images.length === 2 && images.every((art) => art.complete && art.naturalWidth > 0);
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
    const amount = dialog.getByLabel('MAX USDC TO SPEND', { exact: false });
    assert.equal(await amount.inputValue(), '1');
    assert.equal(await dialog.locator('.trade-details').evaluate((node) => node.open), false);
    assert.equal(await dialog.getByLabel('Estimated tokens received').inputValue(), '1');
    await amount.fill('0.02');
    await amount.fill('0.03');
    await amount.fill('0.04');
    assert.ok(await dialog.getByText('Updating your buy quote…').isVisible());
    assert.ok(await dialog.getByRole('button', { name: 'BUY NOW', exact: false }).isDisabled());
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
    assert.equal(await page.locator('.marquee').textContent(), '');
    assert.equal(await page.locator('.marquee-track').count(), 0);
  } finally { await context.close(); }
});

test('ticker stays empty until data and photos are ready, then reveals right-to-left with equal-size photos', async () => {
  const { context, page, errors } = await fixture({ width: 1440, total: 6, delay: 40, artwork: true, mediaDelay: 600, imageDelay: 450 });
  try {
    await page.goto(origin + '/');
    const ticker = page.getByRole('group', { name: 'Live market ticker' });
    const initialHeight = (await ticker.boundingBox()).height;
    await page.locator('.carousel-card').filter({ hasText: 'Pixel Possum' }).first().waitFor();
    assert.equal(await ticker.textContent(), '', 'there must be no placeholder while photos are preparing');
    await page.locator('.marquee-track[data-ready="true"]').waitFor();
    assert.equal((await ticker.boundingBox()).height, initialHeight, 'the header must not jump when the ticker appears');
    const avatars = page.locator('.ticker-cycle').first().locator('img.ticker-avatar');
    assert.equal(await avatars.count(), 6);
    const photos = await avatars.evaluateAll((nodes) => nodes.map((node) => ({
      width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
      ready: node.complete && node.naturalWidth > 0, source: node.currentSrc,
    })));
    assert.ok(photos.every((photo) => photo.ready && photo.width === 24 && photo.height === 24 && photo.source.includes('ticker-image.webp')));
    const delays = await page.locator('.ticker-cycle').first().locator('.ticker-item').evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node).animationDelay)));
    assert.ok(delays[0] > delays.at(-1), 'the rightmost item should enter first');
    await page.mouse.move(1200, 300);
    await page.waitForTimeout(1350);
    const offset = () => page.locator('.marquee-track').evaluate((node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).m41);
    const before = await offset();
    await page.waitForTimeout(400);
    const after = await offset();
    assert.ok(before - after > 3 && before - after < 20, `the loop should travel slowly to the left (${before} → ${after})`);
    await ticker.hover();
    const paused = await offset();
    await page.waitForTimeout(250);
    assert.ok(Math.abs((await offset()) - paused) < .5, 'hover should pause the continuous movement');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('ticker falls back for broken photos and remains static with reduced motion', async () => {
  const { context, page } = await fixture({ artwork: true, imageFailure: true, reducedMotion: 'reduce' });
  try {
    await page.goto(origin + '/');
    await page.locator('.marquee-track[data-ready="true"]').waitFor();
    const track = page.locator('.marquee-track');
    assert.equal(await track.evaluate((node) => getComputedStyle(node).animationName), 'none');
    const avatar = track.locator('img.ticker-avatar').first();
    assert.match(await avatar.getAttribute('src'), /memeverse-ticker-mark-v1\.webp$/);
    assert.equal(await avatar.evaluate((node) => node.complete && node.naturalWidth > 0), true);
    assert.ok((await page.locator('.ticker-cycle').first().boundingBox()).width >= 390, 'a short market list should still fill the viewport');
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
    assert.ok(await page.getByRole('dialog').locator('.trade-cta').isDisabled());
    // One button covers the allowance and the buy; the line beneath explains the two confirmations.
    await page.getByRole('dialog').getByRole('button', { name: 'ALLOW USDC & BUY', exact: false }).waitFor({ state: 'visible' });
    assert.match(await page.getByRole('dialog').locator('.trade-line').textContent(), /allow USDC, then buy/);
    assert.equal(await page.getByRole('dialog').locator('.trade-cta').count(), 1);
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
    const units = page.getByRole('dialog').locator('.market-order form > label small');
    assert.equal(await units.count(), 2);
    for (const unit of await units.all()) {
      const metrics = await unit.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const input = node.parentElement.querySelector('input').getBoundingClientRect();
        return { size: parseFloat(getComputedStyle(node).fontSize), right: bounds.right, inputRight: input.right, center: bounds.top + bounds.height / 2, inputCenter: input.top + input.height / 2 };
      });
      assert.ok(metrics.size >= 14, 'USDC must be readable');
      assert.ok(metrics.right <= metrics.inputRight - 12, 'the unit needs breathing room inside the input');
      assert.ok(Math.abs(metrics.center - metrics.inputCenter) <= 2, 'the unit should be centered vertically');
    }
  } finally { await context.close(); }
});

test('trade units stay inside both fields on mobile and scrolling never changes amounts', async () => {
  for (const width of [390, 1440]) {
    const { context, page, errors } = await fixture({ width, reducedMotion: 'reduce' });
    try {
      async function scrollWithoutEditing(input, value, mode) {
        assert.equal(await input.getAttribute('type'), 'text');
        assert.equal(await input.getAttribute('inputmode'), mode);
        await input.fill(value);
        await input.focus();
        await input.hover();
        await page.mouse.wheel(0, -180);
        await page.waitForTimeout(100);
        assert.equal(await input.inputValue(), value);
        assert.equal(await input.evaluate((node) => document.activeElement === node), true);
      }
      await page.goto(origin + '/launch');
      await scrollWithoutEditing(page.getByLabel('TOTAL SUPPLY', { exact: true }), '123456', 'numeric');
      await scrollWithoutEditing(page.getByLabel('STARTING PRICE (USDC)', { exact: true }), '0.012345', 'decimal');
      await page.goto(origin + '/markets');
      await page.locator('.market-card-actions').getByRole('button', { name: 'BUY', exact: true }).click();
      assert.equal(await page.locator('.market-card .origin-chip').count(), 0);
      const dialog = page.getByRole('dialog');
      assert.equal(await dialog.locator('.network-brand').count(), 0);
      assert.equal(await dialog.getByText('REPLACE MARKET IMAGE', { exact: false }).count(), 0);
      for (const side of ['BUY', 'SELL']) {
        await dialog.getByRole('group', { name: 'Trade direction' }).getByRole('button', { name: side, exact: true }).click();
        const amount = dialog.getByLabel(side === 'BUY' ? 'MAX USDC TO SPEND' : 'TOKEN AMOUNT', { exact: false });
        await scrollWithoutEditing(amount, side === 'BUY' ? '1.234567' : '123', side === 'BUY' ? 'decimal' : 'numeric');
        const units = dialog.locator('.market-order form > label small');
        assert.equal(await units.count(), 2);
        for (const unit of await units.all()) {
          const fits = await unit.evaluate((node) => {
            const unit = node.getBoundingClientRect();
            const input = node.parentElement.querySelector('input').getBoundingClientRect();
            return unit.left >= input.left && unit.right <= input.right - 12
              && Math.abs((unit.top + unit.bottom - input.top - input.bottom) / 2) <= 2;
          });
          assert.ok(fits, `${side} unit must stay centered inside the field at ${width}px`);
        }
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test('launch previews form values and requires artwork picked through the preview card', async () => {
  const { context, page } = await fixture({ width: 1440 });
  const uploads = [];
  page.on('request', (request) => { if (request.url().includes('/media/uploads')) uploads.push(request.url()); });
  try {
    await page.goto(origin + '/launch');
    assert.match(await page.getByRole('note', { name: 'No launch fee' }).textContent(), /\$0.*Launch fee.*network gas/i);
    assert.equal(await page.getByLabel('PRICE STEP (USDC)', { exact: true }).count(), 0);
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

test('carousel waits ten seconds, moves exactly one card smoothly, and loops forward', async () => {
  const { context, page } = await fixture({ width: 1440, total: 6 });
  try {
    await page.clock.install();
    await page.goto(origin + '/');
    const track = page.locator('.carousel-track');
    await page.waitForFunction(() => document.querySelectorAll('.carousel-card:not(.carousel-copy)').length === 6);
    await track.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(100);
    const step = await track.evaluate((node) => node.children[1].offsetLeft - node.children[0].offsetLeft);
    const offset = () => track.evaluate((node) => node.scrollLeft);
    await page.clock.runFor(9900);
    assert.equal(await offset(), 0, 'the carousel must stay still between steps');
    await page.clock.runFor(300);
    const moving = await offset();
    assert.ok(moving > 0 && moving < step - 1, 'one soft transition, not an immediate jump');
    await page.clock.runFor(600);
    assert.ok(Math.abs(await offset() - step) <= 1, 'advance exactly one card');
    const stationary = await offset();
    await page.clock.runFor(9000);
    assert.equal(await offset(), stationary);
    await page.locator('.carousel-card:not(.carousel-copy)').nth(2).hover();
    await page.clock.runFor(15000);
    assert.equal(await offset(), stationary, 'hover pauses scheduled steps');
    await page.getByRole('button', { name: 'Pause automatic scrolling' }).click();
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement.blur());
    await page.clock.runFor(15000);
    assert.equal(await offset(), stationary, 'explicit pause stays paused');
    await page.getByRole('button', { name: 'Resume automatic scrolling' }).click();
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement.blur());
    await page.clock.runFor(10800);
    assert.ok(Math.abs(await offset() - 2 * step) <= 1);
    for (let next = 3; next <= 6; next++) {
      await page.clock.runFor(10800);
      assert.ok(Math.abs(await offset() - (next % 6) * step) <= 1, 'wrap forward without a long reverse scroll');
    }
    await page.getByRole('button', { name: 'Previous Explore markets' }).click();
    await page.clock.runFor(800);
    assert.ok(Math.abs(await offset() - 5 * step) <= 1, 'previous wraps back by one card');
    assert.equal(await page.locator('.carousel-copy[aria-hidden="true"][tabindex="-1"]').count(), 12);
  } finally { await context.close(); }
});

test('legacy quotes explain whole-token zero output in one line and hover stays readable', async () => {
  const { context, page, calls, errors } = await fixture({ width: 1440, highPrice: true, reducedMotion: 'reduce' });
  try {
    await page.goto(origin + '/markets');
    await page.locator('.market-card-actions').getByRole('button', { name: 'BUY', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await page.waitForFunction(() => document.querySelector('input[aria-label="Estimated tokens received"]')?.value === '0');
    assert.equal(await dialog.getByLabel('Estimated tokens received').inputValue(), '0');
    assert.match(await dialog.locator('.market-proof dd').first().textContent(), /1.02 USDC/);
    assert.equal(await dialog.locator('.quote-minimum').count(), 0);
    assert.match(await dialog.locator('.whole-token-note').textContent(), /whole tokens only.*1\.02 USDC/);
    assert.equal(await dialog.locator('.whole-token-note button').count(), 0);
    assert.equal(await dialog.getByRole('button', { name: 'ALLOW USDC', exact: false }).count(), 0);
    const buy = dialog.getByRole('button', { name: 'BUY NOW', exact: false });
    assert.ok(await buy.isDisabled());
    const style = (node) => { const css = getComputedStyle(node); return { color: css.color, background: css.backgroundColor, opacity: css.opacity }; };
    const before = await buy.evaluate(style);
    await buy.hover({ force: true });
    await page.waitForTimeout(400);
    assert.deepEqual(await buy.evaluate(style), before, 'a disabled button must not acquire the enabled hover colors');
    assert.notEqual(before.color, before.background);
    const wallet = dialog.locator('.trade-wallet .wallet');
    await wallet.hover();
    await page.waitForTimeout(400);
    const hovered = await wallet.evaluate(style);
    assert.equal(hovered.color, 'rgb(0, 0, 0)');
    assert.equal(hovered.background, 'rgb(198, 244, 50)');
    await dialog.getByLabel('MAX USDC TO SPEND', { exact: false }).fill('1.02');
    await page.waitForFunction(() => document.querySelector('input[aria-label="Estimated tokens received"]')?.value === '1');
    assert.equal(await dialog.getByLabel('MAX USDC TO SPEND', { exact: false }).inputValue(), '1.02');
    assert.deepEqual(calls.quoteBuy, [1000000n, 1020000n]);
    assert.equal(await dialog.locator('.whole-token-note').count(), 0, 'the note disappears once a whole token is affordable');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('fractional contracts display fractional buy output and accept fractional sell amounts', async () => {
  const { context, page, calls, errors } = await fixture({ fractional: true, highPrice: true });
  try {
    await page.goto(origin + '/markets');
    await page.locator('.market-card-actions').getByRole('button', { name: 'BUY', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await page.waitForFunction(() => document.querySelector('input[aria-label="Estimated tokens received"]')?.value === '0.980392');
    assert.equal(await dialog.locator('.quote-minimum').count(), 0);
    assert.equal(await dialog.locator('.whole-token-note').count(), 0, 'fractional markets need no whole-token note');
    assert.match(await dialog.locator('.market-proof').textContent(), /100.5/);
    await dialog.getByRole('group', { name: 'Trade direction' }).getByRole('button', { name: 'SELL', exact: true }).click();
    const input = dialog.getByLabel('TOKEN AMOUNT', { exact: false });
    assert.equal(await input.getAttribute('inputmode'), 'decimal');
    await input.fill('0.123456789012345678');
    await page.waitForFunction(() => !document.querySelector('.quote-feedback'));
    assert.equal(calls.quoteSell.at(-1), 123456789012345678n);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('quick budgets fill the buy amount and a short USDC balance points to funding', async () => {
  const { context, page, calls, errors } = await fixture({ width: 1440, held: 500000n });
  try {
    // Disconnected: no balance is known, so only the quiet funding link appears.
    await page.goto(origin + '/markets');
    await page.locator('.market-card-actions').getByRole('button', { name: 'BUY', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('.fund-link').waitFor();
    assert.equal(await dialog.locator('.fund-usdc').count(), 0);
    const quick = dialog.getByRole('group', { name: 'Quick amounts' });
    assert.deepEqual(await quick.getByRole('button').allTextContents(), ['$1', '$5', '$10', '$25']);
    assert.equal(await quick.getByRole('button', { name: '$1', exact: true }).getAttribute('aria-pressed'), 'true');
    await quick.getByRole('button', { name: '$5', exact: true }).click();
    assert.equal(await dialog.getByLabel('MAX USDC TO SPEND', { exact: false }).inputValue(), '5');
    assert.equal(await quick.getByRole('button', { name: '$5', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => !document.querySelector('.quote-feedback'));
    assert.ok(calls.quoteBuy.includes(5000000n), 'the $5 budget is quoted onchain');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }

  const connected = await fixture({ width: 390, held: 500000n });
  await connected.page.addInitScript(() => {
    window.ethereum = {
      on() {}, removeListener() {},
      async request({ method }) {
        if (method === 'eth_chainId') return '0x4cef52';
        if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return ['0x3333333333333333333333333333333333333333'];
        if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }];
        throw new Error(`Unexpected wallet request: ${method}`);
      },
    };
  });
  try {
    const { page } = connected;
    await page.goto(origin + '/markets');
    await page.locator('.market-card-actions').getByRole('button', { name: 'BUY', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const connect = dialog.getByRole('button', { name: 'Connect a wallet' });
    if (await connect.count()) await connect.click();
    const panel = dialog.locator('.fund-usdc');
    await panel.waitFor();
    assert.match(await panel.textContent(), /Not enough USDC on Arc.*0\.5 USDC/);
    const link = panel.getByRole('link');
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.match(await link.getAttribute('rel'), /noopener/);
    assert.match(await link.getAttribute('href'), /^https:\/\/faucet\.circle\.com/, 'testnet builds point at the faucet');
    const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(size.scroll <= size.width, 'the funding panel fits a phone');
    assert.deepEqual(connected.errors, []);
  } finally { await connected.context.close(); }
});

test('home explains the three starting steps with an external USDC route', async () => {
  const { context, page, errors } = await fixture({ width: 1440 });
  try {
    await page.goto(origin + '/');
    const steps = page.getByRole('region', { name: 'Start in three steps' });
    assert.deepEqual(await steps.locator('strong').allTextContents(), ['GET USDC', 'LAUNCH FOR $0', 'TRADE FROM $1']);
    const funding = steps.locator('a').first();
    assert.equal(await funding.getAttribute('target'), '_blank');
    assert.match(await funding.getAttribute('rel'), /noopener/);
    assert.match(await steps.locator('a').nth(1).getAttribute('href'), /\/launch$/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('home shows trending markets and live trades from the activity index, or an honest empty state', async () => {
  const now = Math.floor(Date.now() / 1000);
  const activity = {
    recent: [
      { market: MARKET, side: 'BUY', trader: '0x52e1d2a7ECe14cb84aA74687Fafe40D5794de2fF', usdc: '5000000', tokens: '1', tx: '0x' + 'ab'.repeat(32), at: now - 120 },
      { market: MARKET, side: 'SELL', trader: '0x1111111111111111111111111111111111111111', usdc: '1250000', tokens: '1', tx: '0x' + 'cd'.repeat(32), at: now - 7200 },
    ],
    markets: { [MARKET]: { holders: 3, trades: 2, volumeUsdc: '6250000', trades24h: 2, volume24hUsdc: '6250000', traders24h: 2, lastTradeAt: now - 120 } },
  };
  for (const width of [1440, 390]) {
    const { context, page, errors } = await fixture({ width, activity });
    try {
      await page.goto(origin + '/');
      const section = page.getByRole('region', { name: 'Market activity' });
      await section.locator('.trending-row').waitFor();
      assert.match(await section.locator('.trending-row').textContent(), /Pixel Possum.*\$PXPS · 3 holders.*\$6\.25.*2 trades today/);
      const toggle = section.getByRole('group', { name: 'Trending period' });
      assert.deepEqual(await toggle.getByRole('button').allTextContents(), ['24H', '7D', '30D', 'ALL']);
      assert.equal(await toggle.getByRole('button', { name: '24H' }).getAttribute('aria-pressed'), 'true');
      const feed = section.locator('.trade-feed li');
      assert.equal(await feed.count(), 2);
      assert.match(await feed.first().textContent(), /0x52e1…e2fF bought \$5 of \$PXPS.*2m ago/);
      assert.match(await feed.nth(1).textContent(), /sold \$1\.25/);
      assert.match(await feed.first().getByRole('link').getAttribute('href'), /\/tx\/0xabab/);
      const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(size.scroll <= size.width, `activity overflows at ${width}px`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  const quiet = { recent: activity.recent.map((trade) => ({ ...trade, at: now - 12 * 86_400 })), markets: { [MARKET]: { ...activity.markets[MARKET], trades24h: 0, volume24hUsdc: '0', traders24h: 0,
    periods: { '24h': { trades: 0, volumeUsdc: '0' }, '7d': { trades: 0, volumeUsdc: '0' }, '30d': { trades: 2, volumeUsdc: '6250000' }, all: { trades: 2, volumeUsdc: '6250000' } } } } };
  const old = await fixture({ width: 1440, activity: quiet });
  try {
    await old.page.goto(origin + '/');
    const section = old.page.getByRole('region', { name: 'Market activity' });
    await section.locator('.trending-row').waitFor();
    // Nothing in 24h or 7d, so the panel opens on 30D; 24H then shows an honest quiet state.
    const toggle = section.getByRole('group', { name: 'Trending period' });
    assert.equal(await toggle.getByRole('button', { name: '30D' }).getAttribute('aria-pressed'), 'true');
    assert.match(await section.locator('.trending-row').textContent(), /\$6\.25.*2 trades this month/);
    await toggle.getByRole('button', { name: '24H' }).click();
    await section.getByText('Quiet today').waitFor();
    assert.equal(await section.locator('.trending-row').count(), 0);
    await toggle.getByRole('button', { name: 'ALL' }).click();
    assert.match(await section.locator('.trending-row').textContent(), /2 trades all time/);
    assert.equal(await section.locator('.trade-feed').evaluate((node) => getComputedStyle(node).overflowY), 'auto', 'the feed scrolls');
  } finally { await old.context.close(); }
  const { context, page } = await fixture({ width: 1440 });
  try {
    await page.goto(origin + '/');
    const section = page.getByRole('region', { name: 'Market activity' });
    await section.getByText('No trades yet').waitFor();
    assert.equal(await section.locator('.trending-row').count(), 0, 'no trend is shown without trades');
  } finally { await context.close(); }
});

test('selling shows the held position with 25%, 50% and MAX presets', async () => {
  const { context, page, errors } = await fixture({ width: 390, fractional: true, held: 41n * 10n ** 18n + 5n * 10n ** 17n });
  await page.addInitScript(() => {
    window.ethereum = {
      on() {}, removeListener() {},
      async request({ method }) {
        if (method === 'eth_chainId') return '0x4cef52';
        if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return ['0x3333333333333333333333333333333333333333'];
        if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }];
        throw new Error(`Unexpected wallet request: ${method}`);
      },
    };
  });
  try {
    await page.goto(origin + '/markets');
    await page.locator('.market-card-actions').getByRole('button', { name: 'SELL', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const connect = dialog.getByRole('button', { name: 'Connect a wallet' });
    if (await connect.count()) await connect.click();
    const holding = dialog.locator('.sell-holding');
    await holding.waitFor();
    assert.match(await holding.textContent(), /You hold 41\.5 PXPS/);
    const presets = dialog.getByRole('group', { name: 'Sell presets' });
    assert.deepEqual(await presets.getByRole('button').allTextContents(), ['25%', '50%', 'MAX']);
    await presets.getByRole('button', { name: '50%' }).click();
    assert.equal(await dialog.getByLabel('TOKEN AMOUNT', { exact: false }).inputValue(), '20.75');
    await presets.getByRole('button', { name: 'MAX' }).click();
    assert.equal(await dialog.getByLabel('TOKEN AMOUNT', { exact: false }).inputValue(), '41.5');
    assert.equal(await presets.getByRole('button', { name: 'MAX' }).getAttribute('aria-pressed'), 'true');
    assert.equal(await dialog.locator('.trade-cta').count(), 1, 'one action button');
    assert.match(await dialog.locator('.trade-cta').textContent(), /SELL NOW/);
    const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(size.scroll <= size.width);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

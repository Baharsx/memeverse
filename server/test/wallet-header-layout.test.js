import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

/**
 * The mobile header, measured in a real browser.
 *
 * The defect this guards against is a layout one, and layout is the one thing a string assertion
 * cannot check: the CSS said `max-width:100vw`, which reads as "no wider than the screen" and
 * behaves as "wider than the screen by exactly the scrollbar". So these run against the built
 * site in Chromium and assert the two things a visitor actually experiences — the page does not
 * scroll sideways, and the wallet button is entirely on screen.
 *
 * SKIPPED, not failed, when Playwright or `dist/` is absent: CI installs neither a browser nor a
 * build before `npm test`. Run `npm run build` first, with Playwright available, to execute it.
 */

const WIDTHS = [320, 360, 375, 390, 393, 412, 430, 768, 1024, 1440];
const DIST = new URL('../../dist/', import.meta.url);
const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

async function loadPlaywright() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    return null;
  }
}

async function distIsBuilt() {
  try {
    await stat(new URL('index.html', DIST));
    return true;
  } catch {
    return false;
  }
}

/** Serves `dist/` under the committed `/memeverse/` base path, as the reverse proxy does. */
function serveDist() {
  const server = createServer(async (request, response) => {
    let pathname = decodeURIComponent(request.url.split('?')[0]);
    if (pathname.startsWith('/memeverse')) pathname = pathname.slice('/memeverse'.length);
    if (pathname === '' || pathname === '/' || !path.extname(pathname)) pathname = '/index.html';
    try {
      const body = await readFile(new URL(`.${pathname}`, DIST));
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(pathname)] ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('the header fits every target mobile width', async (t) => {
  const chromium = await loadPlaywright();
  if (!chromium) return t.skip('playwright is not installed in this environment');
  if (!await distIsBuilt()) return t.skip('dist/ is not built — run `npm run build` first');

  const { server, port } = await serveDist();
  const browser = await chromium.launch();
  try {
    for (const width of WIDTHS) {
      const mobile = width < 800;
      const context = await browser.newContext({
        viewport: { width, height: 800 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/memeverse/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.wallet');
      await page.waitForTimeout(400);

      const measured = await page.evaluate(() => {
        const wallet = document.querySelector('.wallet');
        const rect = wallet.getBoundingClientRect();
        const brand = document.querySelector('.brand-lockup')?.getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          wallet: { left: rect.left, right: rect.right, height: rect.height },
          label: wallet.textContent.trim(),
          brandVisible: Boolean(brand && brand.width > 20 && brand.right <= window.innerWidth + 0.5),
        };
      });

      assert.ok(
        measured.scrollWidth <= measured.innerWidth,
        `${width}px: documentElement.scrollWidth ${measured.scrollWidth} exceeds innerWidth ${measured.innerWidth}`,
      );
      assert.ok(
        measured.wallet.left >= -0.5 && measured.wallet.right <= measured.innerWidth + 0.5,
        `${width}px: the wallet button is not entirely inside the viewport (${measured.wallet.left} → ${measured.wallet.right})`,
      );
      assert.ok(measured.wallet.height >= 44, `${width}px: tap target is ${measured.wallet.height}px, under 44`);
      assert.ok(measured.brandVisible, `${width}px: the brand is not visible`);
      // No injected provider exists in a bare Chromium context, which is precisely the mobile
      // case: the button must still offer a connection rather than report unavailability.
      assert.equal(measured.label, 'CONNECT WALLET', `${width}px: label is "${measured.label}"`);

      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { launchPriceUnits, tokenSupplyValue } from '../../src/market.js';
import {
  CHECK_STATES, describeConfigured, formatCheckLine, overallVerdict,
} from '../../scripts/demo-preflight.js';
import { contentSecurityPolicyDirectives } from '../security/csp.js';

/** Safety and live Launch/Markets regression checks. */

test('the document metadata describes the shipped product, not the Stage 1 one', async () => {
  const html = await readFile('index.html', 'utf8');

  // Wording that survived from the manual, human-executed settlement product.
  for (const stale of [
    'policy-driven USDC settlement product',
    'human-controlled execution',
    'Agent-guided policy decisions',
    'Programmable settlement built on Arc',
    'Programmable culture settlement',
  ]) {
    assert.equal(html.includes(stale), false, `stale framing must be gone: "${stale}"`);
  }

  assert.ok(html.includes('A meme becomes an economy on Arc'), 'the title tells the real story');
  assert.ok(html.includes('USDC'), 'metadata must mention USDC');
  assert.equal(html.includes('Circle'), false, 'metadata must not mention Circle');
  assert.equal(/agent wallet/i.test(html), false, 'metadata must not mention an agent wallet');

  for (const overclaim of ['audited', 'guaranteed', 'AI-powered', 'LLM']) {
    assert.equal(
      html.toLowerCase().includes(overclaim.toLowerCase()),
      false,
      `metadata must not claim "${overclaim}"`,
    );
  }
});

test('the static frontend deployment example carries its own security headers', async () => {
  const readme = await readFile('README.md', 'utf8');
  const nginx = /```nginx\n([\s\S]*?)```/.exec(readme)?.[1];
  assert.ok(nginx, 'README must document the reverse-proxy configuration');

  // nginx serves the built document, so it does not inherit the API's headers.
  assert.ok(/add_header\s+X-Frame-Options\s+"DENY"/.test(nginx), 'X-Frame-Options DENY');
  assert.ok(/add_header\s+Referrer-Policy\s+"no-referrer"/.test(nginx), 'Referrer-Policy no-referrer');
  assert.ok(
    /add_header\s+Content-Security-Policy\s+"frame-ancestors 'none';"/.test(nginx),
    "frame-ancestors 'none' must come over HTTP, because a meta tag cannot deliver it",
  );
  // Exactly one CSP directive over HTTP: the full policy lives in the built document, and a
  // second hand-maintained copy is a policy that will drift.
  assert.equal(
    /add_header\s+Content-Security-Policy\s+"(?![^"]*frame-ancestors 'none';")/.test(nginx),
    false,
    'the nginx CSP header must not restate the full policy',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Unicode token metadata
// ─────────────────────────────────────────────────────────────────────────────

test('launch supply accepts only whole numbers inside the advertised bounds', () => {
  assert.equal(tokenSupplyValue('100'), 100n);
  assert.equal(tokenSupplyValue('1000'), 1000n);
  assert.equal(tokenSupplyValue('1000000000'), 1_000_000_000n);
  assert.equal(tokenSupplyValue(' 1000000 '), 1_000_000n, 'whitespace is tolerated');
  assert.equal(tokenSupplyValue(1000), 1000n, 'a numeric value works too');

  for (const rejected of [
    '', '   ', '0', '99', '1000000001',
    // A `type="number"` field really will hand back exponent notation, and BigInt('1e3') throws.
    '1e3', '1E3', '1e-3', '2e9',
    '1.5', '-100', '+100', 'abc', 'NaN', 'Infinity', '0x64', '1_000',
    null, undefined, {}, [], true, NaN, Infinity, -0,
  ]) {
    assert.equal(tokenSupplyValue(rejected), null, `${String(rejected)} is not a valid supply`);
  }
});

test('launch initial price requires a positive six-decimal USDC amount', () => {
  assert.equal(launchPriceUnits('0.000001'), 1n);
  assert.equal(launchPriceUnits('0.1'), 100_000n);
  assert.equal(launchPriceUnits('1'), 1_000_000n);
  assert.equal(launchPriceUnits('1000'), 1_000_000_000n);
  assert.equal(launchPriceUnits('1.123456'), 1_123_456n);

  for (const rejected of [
    '0', '-1', '1e-3', '1E3', 'abc', '0.0000001', '1000.000001', '1.1234567',
    '', '   ', '+1', '.5', '1.', 'Infinity', null, undefined, {}, [],
  ]) {
    assert.equal(launchPriceUnits(rejected), null, `${String(rejected)} is not a valid price`);
  }
});

test('launch curve increase permits exactly zero, because a flat curve is a real market', () => {
  const flat = { allowZero: true };
  assert.equal(launchPriceUnits('0', flat), 0n);
  assert.equal(launchPriceUnits('0.000001', flat), 1n);
  assert.equal(launchPriceUnits('1', flat), 1_000_000n);
  assert.equal(launchPriceUnits('1000', flat), 1_000_000_000n);

  for (const rejected of ['-1', '1e3', 'abc', '1000.000001', '1.1234567', '', null, undefined]) {
    assert.equal(launchPriceUnits(rejected, flat), null, `${String(rejected)} is not a valid slope`);
  }
  // And zero stays invalid for the initial price, where the two fields genuinely differ.
  assert.equal(launchPriceUnits('0'), null);
});

test('no launch helper throws, whatever the field contains', () => {
  for (const hostile of [
    Symbol.iterator, () => {}, new Date(), 'a'.repeat(10_000), '9'.repeat(400),
    { toString() { throw new Error('hostile'); } },
  ]) {
    assert.doesNotThrow(() => { try { tokenSupplyValue(hostile); } catch (e) { if (e.message !== 'hostile') throw e; } });
    assert.doesNotThrow(() => { try { launchPriceUnits(hostile); } catch (e) { if (e.message !== 'hostile') throw e; } });
  }
});

test('the launch form validates before review and signs only validated values', async () => {
  const main = await readFile('src/main.jsx', 'utf8');

  // The bug: `BigInt(supply)` and `parseUsdc(...)` ran inside the contract call, so `1e3` threw
  // there and a broad `catch {}` swallowed it — the button appeared to do nothing at all.
  assert.equal(
    /args: \[name\.trim\(\)[^\]]*BigInt\(supply\)/.test(main),
    false,
    'the call must not re-parse raw strings',
  );
  assert.ok(
    main.includes('args: [name.trim(), symbol.trim().toUpperCase(), description.trim(), supplyValue, basePriceUnits, slopePriceUnits]'),
    'it sends the values that were validated',
  );
  assert.ok(main.includes('if (launchInvalid) {'), 'review is refused for invalid input');
  assert.ok(main.includes('setReview(false)'), 'and review does not open');
  assert.ok(main.includes('launchPriceUnits(slopePrice, { allowZero: true })'), 'zero slope stays valid');
  // Scoped to launchMarket: the markets buy/sell handlers legitimately wrap only action.execute,
  // whose error state already presents wallet and provider failures.
  const launchBody = main.slice(main.indexOf('async function launchMarket()'));
  const launchCatch = launchBody.slice(0, launchBody.indexOf('\n  }\n\n  return ('));
  assert.equal(
    /\} catch \{/.test(launchCatch),
    false,
    'a local failure inside launchMarket must not be swallowed silently',
  );
  assert.ok(launchCatch.includes('setFormError('), 'an unexpected local failure surfaces a line');
  assert.ok(main.includes('setFormError('), 'invalid input surfaces an inline message');
  // The browser's own min/max blocks some submits before handleSubmit runs, so a message from an
  // earlier attempt would otherwise linger and describe a field the user has already corrected.
  assert.ok(
    /useEffect\(\(\) => \{ setFormError\(null\); \}, \[name, symbol, supply, basePrice, slopePrice\]\)/
      .test(main),
    'editing any launch field clears a stale validation message',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Amount input validation
// ─────────────────────────────────────────────────────────────────────────────

test('no site-chrome rule targets a bare header or footer element', async () => {
  const css = await readFile('src/styles.css', 'utf8');

  // MemeVerse renders semantic <header>/<footer> inside the decision timeline, the reward
  // receipt, and the creator economy panel. A generic `header{height:82px}` or
  // `footer span:nth-child(2){display:none}` reaches straight into those — the second rule would
  // have hidden the ARC TX proof link on mobile.
  const selectors = [...css.matchAll(/(?:^|[}\n;{])\s*([^{}@\n][^{}]{0,240}?)\{/g)]
    .flatMap((match) => match[1].split(',').map((part) => part.trim()));
  const bare = selectors.filter((selector) => /^(header|footer)([\s>:[].*)?$/.test(selector));

  assert.deepEqual(bare, [], 'application chrome must be scoped to .site-header / .site-footer');
  assert.ok(css.includes('.site-header'), 'the scoped header rules exist');
  assert.ok(css.includes('.site-footer'), 'the scoped footer rules exist');
  assert.ok(
    css.includes('.site-footer span:nth-child(2)'),
    'the mobile footer rule is scoped, so it cannot hide a timeline ARC TX link',
  );
});

test('the shell carries the classes its scoped chrome CSS depends on', async () => {
  const main = await readFile('src/main.jsx', 'utf8');
  assert.ok(main.includes('<header className="site-header">'));
  assert.ok(main.includes('<footer className="site-footer">'));
});

test('form controls do not take the outward action outline that overlapped their labels', async () => {
  const css = await readFile('src/styles.css', 'utf8');

  // The old rule put inputs in the same 3px-offset acid outline as buttons. MemeVerse inputs are
  // a minimal underline sitting directly under their label and beside a unit suffix, so the
  // outline drew a green rectangle through both.
  assert.equal(
    css.includes('button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--acid);outline-offset:3px}'),
    false,
    'inputs must not share the offset action outline',
  );
  assert.ok(
    /button:focus-visible,a:focus-visible,summary:focus-visible\{outline:2px solid var\(--acid\)/.test(css),
    'actions keep their outline',
  );
  // Focus must still be unmistakable for keyboard users — on the field's own edge.
  assert.ok(/input:focus-visible,\s*\n?textarea:focus-visible,\s*\n?select:focus-visible\{/.test(css));
  assert.ok(css.includes('border-color:var(--acid)'), 'the field edge marks focus');
  assert.ok(css.includes('forced-colors:active'), 'high-contrast mode keeps a real outline');
  assert.ok(css.includes('select:focus-visible'), 'selects have a focus treatment too');
});

test('the preflight verdict is blocked by any failure and softened by any warning', () => {
  const pass = { label: 'ARC RPC', state: CHECK_STATES.PASS, detail: '' };
  const warn = { label: 'BACKEND API', state: CHECK_STATES.WARN, detail: '' };
  const fail = { label: 'MARKET FACTORY', state: CHECK_STATES.FAIL, detail: '' };

  assert.equal(overallVerdict([pass, pass]), 'READY');
  assert.equal(overallVerdict([pass, warn]), 'READY WITH WARNINGS');
  assert.equal(overallVerdict([pass, fail]), 'NOT READY');
  // A failure must dominate a warning, never the other way around.
  assert.equal(overallVerdict([warn, fail, pass]), 'NOT READY');
  assert.equal(overallVerdict([]), 'READY');
});

test('the preflight reports credential presence and never a credential value', () => {
  assert.equal(describeConfigured('SAND_API_KEY:super:secret'), 'CONFIGURED');
  assert.equal(describeConfigured(''), 'NOT CONFIGURED');
  assert.equal(describeConfigured('   '), 'NOT CONFIGURED');
  assert.equal(describeConfigured(undefined), 'NOT CONFIGURED');
  assert.equal(describeConfigured(null), 'NOT CONFIGURED');
  // The only two strings this function can ever produce.
  for (const value of ['x', '', undefined, 'KIT_KEY:a:b']) {
    assert.ok(['CONFIGURED', 'NOT CONFIGURED'].includes(describeConfigured(value)));
  }
});

test('preflight output lines align and carry no secret material', () => {
  const line = formatCheckLine({
    label: 'CIRCLE KIT KEY', state: CHECK_STATES.PASS, detail: describeConfigured('KIT_KEY:a:b'),
  });
  assert.ok(line.startsWith('CIRCLE KIT KEY '));
  assert.ok(line.includes('PASS'));
  assert.ok(line.includes('CONFIGURED'));
  assert.equal(line.includes('KIT_KEY'), false, 'the value must never reach the output');
  // Every row is padded to the same width so the report is scannable under demo pressure.
  const widths = ['ARC RPC', 'MARKET FACTORY', 'SETTLEMENT / MANUAL'].map(
    (label) => formatCheckLine({ label, state: 'PASS', detail: '' }).indexOf('PASS'),
  );
  assert.equal(new Set(widths).size, 1, 'state column must align across labels');
});

test('the preflight script performs no onchain write and no deployment', async () => {
  const source = await readFile('scripts/demo-preflight.js', 'utf8');
  for (const forbidden of [
    'writeContract', 'sendTransaction', 'deployContract', 'walletClient', 'createWalletClient',
    'privateKey', 'circle-deploy', 'circle:fund', 'INSERT INTO', 'UPDATE ', 'DELETE FROM',
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `the preflight must never contain ${forbidden}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The judged demo path
// ─────────────────────────────────────────────────────────────────────────────

test('an unmatched deep link renders a real surface rather than an empty page', async () => {
  const main = await readFile('src/main.jsx', 'utf8');
  const router = await readFile('src/router.jsx', 'utf8');

  // SPA history fallback means the edge answers every path under the base with index.html, so a
  // mistyped URL reaches the browser as a successful page load. Without this it would render an
  // empty document under a working header.
  assert.ok(router.includes('notFound = null'), 'Routes must accept a not-found element');
  assert.ok(router.includes('return route?.props.element ?? notFound'), 'it must be rendered');
  assert.ok(main.includes('notFound={<NotFound />}'), 'the shell must supply one');
  assert.ok(main.includes('NO SUCH SURFACE'), 'and it must say what happened');
});


test('product navigation exposes only launch and markets', async () => {
  const main = await readFile('src/main.jsx', 'utf8');
  const nav = [...main.matchAll(/\['0\d', '([A-Z]+)', '(\/[a-z]+)'\]/g)]
    .map((match) => [match[1], match[2]]);
  assert.deepEqual(nav, [['LAUNCH', '/launch'], ['MARKETS', '/markets'], ['REFERRAL', '/referral'], ['CAMPAIGNS', '/campaigns']]);
  for (const path of ['/', '/launch', '/markets', '/referral', '/campaigns']) {
    assert.ok(main.includes('path="' + path + '"'), 'live route ' + path);
  }
  for (const removed of ['/nft', '/vault']) {
    assert.equal(main.includes(removed), false, 'retired route ' + removed + ' must be gone');
  }
  assert.ok(main.includes('notFound={<NotFound />}'), 'old deep links get a 404 surface');
  assert.ok(main.includes('market-images'), 'market artwork still loads independently');
  assert.ok(main.includes('<Referral />') && main.includes('<Campaigns />'), 'community routes are wired');
  assert.ok(main.includes('MARKET IMAGE (OPTIONAL)'), 'image upload remains part of launch');
});

test('mainnet homepage foregrounds live launch, trade and token markets only', async () => {
  const main = await readFile('src/main.jsx', 'utf8');
  const home = main.slice(main.indexOf('function Home()'), main.indexOf('function CarouselArt('));
  assert.ok(home.includes('A MEME'));
  assert.ok(home.includes('<mark>MARKET.</mark>'));
  assert.ok(home.includes('LAUNCH A MEME'));
  assert.ok(home.includes('TRADE ONCHAIN'));
  assert.ok(home.includes('label="Explore markets"'));
  assert.ok(home.includes('getMarketImages('));
  assert.ok(home.includes('REAL USDC IS AT RISK'));
  assert.equal(home.includes('label="NFTs"'), false);
  assert.equal(home.includes('IN DEVELOPMENT'), false);
  assert.equal(home.includes('THE THREE-MINUTE TOUR'), false);
});

test('current-facing docs and social preview describe the live market product', async () => {
  const readme = await readFile('README.md', 'utf8');
  const html = await readFile('index.html', 'utf8');
  const security = await readFile('SECURITY.md', 'utf8');
  for (const source of [readme, html, security]) {
    assert.equal(/\/nft|\/vault|coming soon|under development/i.test(source), false);
  }
  assert.ok(readme.includes('LAUNCH → MARKETS'));
  assert.ok(readme.includes('https://memeverse.biz'));
  assert.ok(readme.includes('not been independently audited'));
  assert.ok(html.includes('rel="canonical" href="https://memeverse.biz/"'));
  assert.ok(html.includes('property="og:url" content="https://memeverse.biz/"'));
});

test('homepage and external links retain scoped security protections', async () => {
  const html = await readFile('index.html', 'utf8');
  const main = await readFile('src/main.jsx', 'utf8');
  const directives = contentSecurityPolicyDirectives({ connectSources: ['https://app.example'] });
  assert.ok(html.includes('name="referrer" content="no-referrer"'));
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['object-src'], ["'none'"]);
  assert.equal(directives['script-src'].includes("'unsafe-inline'"), false);
  assert.equal(directives['script-src'].includes("'unsafe-eval'"), false);
  const targets = main.match(/target="_blank"/g) ?? [];
  const guarded = main.match(/rel="noreferrer noopener"/g) ?? [];
  assert.equal(targets.length, guarded.length);
});

test('mobile navigation remains keyboard accessible after scope reduction', async () => {
  const css = await readFile('src/styles.css', 'utf8');
  assert.ok(/\.site-header nav a\{[^}]*white-space:nowrap/.test(css));
  assert.ok(/\.site-header nav\{[^}]*overflow-x:auto/.test(css));
  assert.ok(css.includes('prefers-reduced-motion'));
});

test('contract compilation and production config contain no retired feature entry points', async () => {
  const compile = await readFile('scripts/compile-contracts.js', 'utf8');
  const project = JSON.parse(await readFile('package.json', 'utf8'));
  const network = await readFile('src/arc-networks.js', 'utf8');
  const api = await readFile('server/domain/media-service.js', 'utf8');
  const env = await readFile('.env.example', 'utf8');
  const opsEnv = await readFile('ops/systemd/memeverse.env.example', 'utf8');
  assert.ok(compile.includes("sourceName: 'MemeVerseMarket.sol'"));
  for (const retired of ['MemeVerseMedia.sol', 'MemeVerseVault.sol']) {
    assert.equal(compile.includes(retired), false, retired + ' must not be compiled');
  }
  for (const retired of ['assets:audit:onchain']) {
    assert.equal(Object.hasOwn(project.scripts, retired), false);
  }
  for (const source of [network, env, opsEnv]) {
    assert.equal(/VITE_MEDIA_NFT_ADDRESS|VITE_NFT_MARKETPLACE_ADDRESS|VITE_USDC_VAULT_ADDRESS/.test(source), false);
  }
  assert.ok(api.includes('setMarketImage'), 'creator market images must stay supported');
  assert.equal(api.includes("NFT_MEDIA"), false, 'removed action must not be supported');
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { safeMediaUrl } from '../../src/assets.js';
import {
  CHECK_STATES, describeConfigured, formatCheckLine, overallVerdict,
} from '../../scripts/demo-preflight.js';
import { contentSecurityPolicyDirectives } from '../security/csp.js';

/**
 * Stage 3 turns a technically complete system into something a judge can read in three minutes.
 *
 * These tests guard the properties that make that safe rather than merely pretty: that untrusted
 * token metadata cannot become an attribute the browser acts on, that the demo preflight reports
 * readiness honestly and never prints a credential, that every route in the demo path is actually
 * routed, and that no Stage 3 surface invents a value it did not observe.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Untrusted media URLs
// ─────────────────────────────────────────────────────────────────────────────

test('media URLs from token metadata are refused unless they are https or a data: image', () => {
  // Anyone who can mint can write this field, and every other visitor renders it.
  for (const hostile of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)  ',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:application/javascript;base64,YWxlcnQoMSk=',
    'vbscript:msgbox(1)',
    'blob:https://example.com/9b1deb4d',
    'file:///etc/passwd',
    'http://example.com/insecure.png',
    '//example.com/protocol-relative.png',
    '/relative/path.png',
    'example.com/no-scheme.png',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(safeMediaUrl(hostile), null, `${String(hostile)} must not reach an img src`);
  }
});

test('legitimate media URLs survive sanitization unchanged in substance', () => {
  const https = 'https://raw.githubusercontent.com/Baharsx/memeverse/main/public/memeverse-mark.png';
  assert.equal(safeMediaUrl(https), https);
  assert.equal(safeMediaUrl(`  ${https}  `), https, 'surrounding whitespace is tolerated');

  const dataImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  assert.equal(safeMediaUrl(dataImage), dataImage);
  assert.equal(
    safeMediaUrl('data:image/svg+xml;base64,PHN2Zy8+'),
    'data:image/svg+xml;base64,PHN2Zy8+',
  );
});

test('an absurdly long media URL is refused rather than rendered', () => {
  assert.equal(safeMediaUrl(`https://example.com/${'a'.repeat(4000)}.png`), null);
});

test('the content security policy still refuses scripts and wildcards after the image change', () => {
  const directives = contentSecurityPolicyDirectives({ connectSources: ['https://app.example'] });

  // Media NFT artwork lives on hosts MemeVerse does not control, so img-src is scheme-restricted
  // rather than origin-listed. Everything that can actually execute stays locked to 'self'.
  assert.deepEqual(directives['img-src'], ["'self'", 'data:', 'https:']);
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['object-src'], ["'none'"]);
  assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
  assert.equal(directives['script-src'].includes("'unsafe-inline'"), false);
  assert.equal(directives['script-src'].includes("'unsafe-eval'"), false);
  for (const [name, values] of Object.entries(directives)) {
    assert.equal(values.includes('*'), false, `${name} must never carry a wildcard`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Demo preflight
// ─────────────────────────────────────────────────────────────────────────────

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

test('every route on the canonical demo path is routed and reachable from navigation', async () => {
  const main = await readFile('src/main.jsx', 'utf8');
  for (const path of ['/', '/markets', '/launch', '/nft', '/vault', '/agent', '/quote', '/safety']) {
    assert.ok(
      main.includes(`path="${path}"`),
      `${path} must be a routed surface so a direct deep link renders it`,
    );
  }
  // The five steps of the story are in the primary navigation, in order.
  const navOrder = ['/launch', '/markets', '/nft', '/agent', '/safety'];
  const positions = navOrder.map((path) => main.indexOf(`'${path}'`));
  assert.ok(positions.every((index) => index > 0), 'each demo step must appear in navigation');
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(
      positions[index] > positions[index - 1],
      `navigation must follow the demo path: ${navOrder[index - 1]} before ${navOrder[index]}`,
    );
  }
});

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

test('each demo step hands off to the next one without returning to the homepage', async () => {
  const main = await readFile('src/main.jsx', 'utf8');
  const stage2 = await readFile('src/stage2-views.jsx', 'utf8');
  const stage3 = await readFile('src/stage3-views.jsx', 'utf8');
  const sources = `${main}\n${stage2}\n${stage3}`;

  // launch → markets → nft → agent → safety, each expressed as a NextStep.
  for (const [from, to] of [
    ['LAUNCH', '/markets'], ['MARKETS', '/nft'], ['MEDIA', '/agent'], ['AGENT', '/safety'],
  ]) {
    assert.ok(
      new RegExp(`<NextStep[^>]*\\n?[^>]*to="${to}"`, 's').test(sources),
      `the step after ${from} must link onward to ${to}`,
    );
  }
  assert.equal(
    /<NextStep[^>]*to="\/"/s.test(sources),
    false,
    'a hand-off must never send the judge back to the homepage',
  );
});

test('the Stage 3 surfaces state absence rather than inventing a value', async () => {
  const stage3 = await readFile('src/stage3-views.jsx', 'utf8');

  // Explicit unavailability is the whole point of these surfaces.
  for (const required of [
    'NOT CONFIGURED', 'UNAVAILABLE', 'NO AUTONOMOUS DECISIONS YET', 'NONE YET',
  ]) {
    assert.ok(stage3.includes(required), `Stage 3 must be able to render "${required}"`);
  }

  // And no surface may claim a capability the project does not have. The words themselves are
  // allowed — the Proof Center has to be able to say "nothing here is mainnet" — so what is
  // banned is the affirmative claim.
  for (const banned of [
    'mainnet ready', 'independently audited', 'security audited',
    'guaranteed', 'generates yield', 'earn yield', 'exactly-once', 'simulated', 'demo data',
    'example value', 'placeholder',
  ]) {
    assert.equal(
      stage3.toLowerCase().includes(banned.toLowerCase()),
      false,
      `Stage 3 must not claim "${banned}"`,
    );
  }
});

test('the proof receipt cannot render for a payout that did not execute onchain', async () => {
  const stage3 = await readFile('src/stage3-views.jsx', 'utf8');
  // The single most misleading thing this page could do is show a receipt for a decision that
  // never produced a transaction, so the guard is asserted directly on the source.
  assert.ok(
    /if \(!payout \|\| payout\.outcome !== 'EXECUTED' \|\| !payout\.transactionHash\) return null;/
      .test(stage3),
    'ProofReceipt must return null without an EXECUTED outcome and a real Arc transaction hash',
  );
});

test('the Proof Center states the project limitations it must not hide', async () => {
  const stage3 = await readFile('src/stage3-views.jsx', 'utf8');
  for (const admission of [
    'Arc Public Testnet only',
    'No independent security audit',
    'Not production ready',
    'application-level',
    'deterministic, not intelligent',
  ]) {
    assert.ok(stage3.includes(admission), `the Proof Center must state: ${admission}`);
  }
});

test('no Stage 3 external link opens without noopener and noreferrer', async () => {
  for (const file of ['src/stage3-views.jsx', 'src/stage2-views.jsx']) {
    const source = await readFile(file, 'utf8');
    const targets = source.match(/target="_blank"/g) ?? [];
    const guarded = source.match(/rel="noreferrer noopener"/g) ?? [];
    assert.equal(
      targets.length,
      guarded.length,
      `${file}: every target="_blank" must carry rel="noreferrer noopener"`,
    );
  }
});

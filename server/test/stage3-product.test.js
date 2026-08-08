import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodeMetadata, jsonDataUri, safeMediaUrl, usdcAmountUnits } from '../../src/assets.js';
import { launchPriceUnits, tokenSupplyValue } from '../../src/market.js';
import { autonomyDisplayState } from '../../src/agent-status.js';
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
// Agent status truthfulness
// ─────────────────────────────────────────────────────────────────────────────

test('the agent never reads ACTIVE unless it is configured, LIVE, loaded, and unpaused', () => {
  const live = { executor: { configured: true, state: 'LIVE' }, paused: false };
  assert.equal(autonomyDisplayState({ loaded: true, data: live }), 'ACTIVE');

  // Every way infrastructure can be absent, and none of them may look healthy. The Proof Center
  // previously answered ACTIVE for the first three of these, because it only checked `paused`.
  assert.equal(autonomyDisplayState({ loaded: false, data: undefined }), 'UNAVAILABLE', 'pending');
  assert.equal(autonomyDisplayState({ loaded: false, data: live }), 'UNAVAILABLE', 'not loaded');
  assert.equal(autonomyDisplayState({ loaded: true, data: undefined }), 'UNAVAILABLE', 'failed');
  assert.equal(autonomyDisplayState({ loaded: true, data: {} }), 'UNAVAILABLE', 'no executor');
  assert.equal(
    autonomyDisplayState({ loaded: true, data: { executor: { configured: false }, paused: false } }),
    'UNAVAILABLE',
    'an unconfigured Agent Wallet is not an active agent',
  );
  assert.equal(
    autonomyDisplayState({
      loaded: true, data: { executor: { configured: true, state: 'UNAVAILABLE' }, paused: false },
    }),
    'UNAVAILABLE',
    'a lapsed Agent Wallet session cannot pay, so it is not active',
  );
  assert.equal(autonomyDisplayState(), 'UNAVAILABLE', 'called with nothing at all');
});

test('a deliberately stopped agent reads PAUSED rather than broken', () => {
  assert.equal(
    autonomyDisplayState({
      loaded: true, data: { executor: { configured: true, state: 'LIVE' }, paused: true },
    }),
    'PAUSED',
  );
  // Configured but stopped is still PAUSED even if the wallet session has also lapsed: an
  // operator engaged the emergency stop, and that is the fact worth reporting.
  assert.equal(
    autonomyDisplayState({
      loaded: true, data: { executor: { configured: true, state: 'UNAVAILABLE' }, paused: true },
    }),
    'PAUSED',
  );
});

test('both agent surfaces derive their status from the one shared rule', async () => {
  const stage3 = await readFile('src/stage3-views.jsx', 'utf8');
  // The Command Center and the Proof Center drifted once. Neither may re-implement the rule.
  assert.equal(
    (stage3.match(/autonomyDisplayState\(/g) ?? []).length,
    2,
    'the Agent Command Center and the Proof Center must both call the shared helper',
  );
  assert.equal(
    /paused \? 'PAUSED' : 'ACTIVE'/.test(stage3),
    false,
    'no surface may decide ACTIVE from the pause flag alone',
  );
});

test('the agent explains what it does before it explains what it is not', async () => {
  const stage3 = await readFile('src/stage3-views.jsx', 'utf8');

  // Leading with the disclaimer taught a judge what MemeVerse is not before they understood what
  // it is. The autonomy comes first; the deterministic-policy note stays, but underneath.
  const heading = stage3.indexOf('OBSERVE → DECIDE → PAY → PROVE');
  const llmNote = stage3.indexOf('No LLM participates in the payout decision');
  assert.ok(heading > 0, 'the agent surface must lead with what the agent actually does');
  assert.ok(llmNote > heading, 'the determinism note must follow the autonomy, not precede it');
  assert.equal(
    stage3.includes('ECONOMIC ACTOR, NOT A CHATBOT'),
    false,
    'the defensive heading is replaced, not merely supplemented',
  );

  // The four things a judge has to be able to answer, stated on the surface itself.
  for (const claim of [
    'discovers the markets registered',
    'confirmed Arc trading evidence',
    'market.creator()',
    'Circle Agent Wallet',
    'No human approves an individual',
    'reconciled back against Arc',
  ]) {
    assert.ok(stage3.includes(claim), `the agent story must state: ${claim}`);
  }

  // And it still must not claim intelligence it does not have.
  for (const overclaim of ['AI-powered', 'intelligent agent', 'machine learning', 'reasoning model']) {
    assert.equal(
      stage3.toLowerCase().includes(overclaim.toLowerCase()),
      false,
      `the agent must not claim "${overclaim}"`,
    );
  }
});

test('the manual settlement route is preserved but secondary and collapsed by default', async () => {
  const main = await readFile('src/main.jsx', 'utf8');

  // The autonomous surface says no human approves a payout. A human approval form at equal visual
  // weight directly beneath it reads as the same flow, which is the confusion being removed.
  assert.ok(main.includes('<details className="manual-route">'), 'it must be collapsible');
  assert.equal(
    /<details className="manual-route"[^>]*\bopen\b/.test(main),
    false,
    'it must be closed by default',
  );
  assert.ok(main.includes('ADVANCED / SUPPORTING MANUAL ROUTE'), 'and labelled as supporting');
  assert.ok(
    main.includes('not used by autonomous creator rewards'),
    'the summary must say the two routes are separate',
  );

  // Preserved, not deleted: every manual control still exists inside it.
  for (const preserved of [
    'OPERATOR SETTLEMENT ROUTE', 'OperatorSessionPanel', 'REVIEW HUMAN EXECUTION',
    'SETTLEMENT REQUEST', 'runPolicy', 'executeWithCircle',
  ]) {
    assert.ok(main.includes(preserved), `the manual route must keep ${preserved}`);
  }

  // The autonomous surface is outside the <details> and therefore visible by default.
  const detailsAt = main.indexOf('<details className="manual-route">');
  assert.ok(
    main.indexOf('<AgentCommandCenter />') < detailsAt,
    'the Agent Command Center must render before, and outside, the collapsed route',
  );
});

test('the recorded epoch timestamp is not overstated as every evaluation', async () => {
  const stage3 = await readFile('src/stage3-views.jsx', 'utf8');
  // The backend derives this from the most recent payout epoch claim, so an evaluation denied
  // before a claim existed is not represented. The label has to say what the data is.
  assert.equal(
    stage3.includes('label="LAST EVALUATION"'),
    false,
    'the field is not a record of every evaluation and must not claim to be',
  );
  assert.ok(stage3.includes('label="LAST RECORDED EPOCH"'), 'it is a recorded epoch, and says so');
});

test('creator economy rewards are labelled as a recent window, not a lifetime total', async () => {
  const stage3 = await readFile('src/stage3-views.jsx', 'utf8');
  // The status endpoint returns a bounded window of recent epochs, never a complete ledger.
  assert.ok(stage3.includes('RECENT AUTONOMOUS REWARDS'), 'the heading states recency');
  assert.equal(
    /<small>04 AUTONOMOUS REWARDS<\/small>/.test(stage3),
    false,
    'an unqualified heading would read as a lifetime total',
  );
  assert.ok(stage3.includes('IN RECENT WINDOW'), 'and so does the count');
});

// ─────────────────────────────────────────────────────────────────────────────
// Document metadata and referrer leakage
// ─────────────────────────────────────────────────────────────────────────────

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
  for (const required of ['Arc Testnet', 'USDC', 'Circle Agent Wallet', 'provenance']) {
    assert.ok(html.includes(required), `metadata must mention ${required}`);
  }

  // And it must not promise anything the repository cannot prove.
  for (const overclaim of ['mainnet', 'audited', 'guaranteed', 'AI-powered', 'LLM']) {
    assert.equal(
      html.toLowerCase().includes(overclaim.toLowerCase()),
      false,
      `metadata must not claim "${overclaim}"`,
    );
  }
});

test('the document and every untrusted media request suppress the referrer', async () => {
  const html = await readFile('index.html', 'utf8');
  const stage2 = await readFile('src/stage2-views.jsx', 'utf8');

  assert.ok(
    /<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>/.test(html),
    'the document must set a no-referrer policy',
  );
  // The image host is chosen by whoever minted the token, so it must not learn which MemeVerse
  // page the visitor is on — stated on the element itself, not only at document level.
  assert.ok(
    /<img[^>]*referrerPolicy="no-referrer"/s.test(stage2),
    'the untrusted media <img> must carry referrerPolicy="no-referrer"',
  );
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

test('token metadata survives a round trip through emoji and non-Latin scripts', () => {
  // `btoa` is defined over Latin-1, so the previous `btoa(JSON.stringify(…))` threw
  // InvalidCharacterError on every one of these — while *rendering* the mint panel, before the
  // user could click anything. These are ordinary meme names, not adversarial input.
  for (const name of [
    'MemeVerse Media',
    'DOGE 🚀',
    'میم ایرانی',
    '猫コイン',
    'GN 🌙 / creator اقتصاد',
    '👨‍👩‍👧‍👦 family zwj',
    'Ω≈ç√∫˜µ≤≥÷',
    'line\nbreak\ttab "quoted" \\backslash',
  ]) {
    const metadata = {
      name,
      description: `${name} — bound onchain to a MemeVerse market.`,
      image: 'https://example.com/x.png',
      attributes: [{ trait_type: 'market', value: '0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D' }],
    };
    const uri = jsonDataUri(metadata);
    assert.ok(uri.startsWith('data:application/json;base64,'), 'the URI stays self-contained');
    const decoded = decodeMetadata(uri);
    assert.equal(decoded.name, name, `${name} must survive exactly`);
    assert.deepEqual(decoded, metadata, 'every field round-trips unchanged');
  }
});

test('metadata encoding produces bytes a plain base64 decoder agrees with', () => {
  // Independent check: decode with Buffer rather than the app's own decoder, so a symmetric bug
  // in both halves cannot hide.
  const metadata = { name: 'DOGE 🚀', description: 'میم' };
  const base64 = jsonDataUri(metadata).slice('data:application/json;base64,'.length);
  assert.deepEqual(JSON.parse(Buffer.from(base64, 'base64').toString('utf8')), metadata);
});

test('a large metadata blob encodes without exceeding an argument limit', () => {
  const metadata = { name: '🚀'.repeat(20_000) };
  assert.doesNotThrow(() => jsonDataUri(metadata));
  assert.equal(decodeMetadata(jsonDataUri(metadata)).name, metadata.name);
});

test('malformed metadata still fails closed instead of throwing into the UI', () => {
  for (const hostile of [
    'data:application/json;base64,!!!not-base64!!!',
    `data:application/json;base64,${Buffer.from('{ not json').toString('base64')}`,
    // Valid base64 whose bytes are not valid UTF-8 — the decoder must refuse, not mojibake.
    `data:application/json;base64,${Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')}`,
    'data:application/json;base64,',
    'https://example.com/not-a-data-uri.json',
    '', '   ', null, undefined, 42, {}, [],
  ]) {
    assert.doesNotThrow(() => decodeMetadata(hostile));
    assert.equal(decodeMetadata(hostile), null, `${String(hostile)} must decode to null`);
  }
});

test('the mint panel encodes through the UTF-8 helper, never raw btoa', async () => {
  const stage2 = await readFile('src/stage2-views.jsx', 'utf8');
  assert.equal(
    /btoa\(JSON\.stringify/.test(stage2),
    false,
    'raw btoa over a JSON string throws on any character above U+00FF',
  );
  assert.ok(stage2.includes('jsonDataUri(metadata)'), 'it uses the UTF-8-safe encoder');
});

// ─────────────────────────────────────────────────────────────────────────────
// Launch input validation
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

test('a USDC amount field never enables an action it cannot actually parse', () => {
  // The bug: the button gated on `Number(value) <= 0`. `Number('abc')` is NaN and `NaN <= 0` is
  // false, so a malformed price passed the guard, enabled the LIST button, and left parseUnits to
  // throw at click time on a value the interface had already accepted.
  for (const rejected of [
    '', '   ', 'abc', '0', '0.0', '-1', '-0.5', '1e100', '1e-7', 'NaN', 'Infinity',
    '0.0000001', '1.1234567', '1,5', '+1', ' 1 2 ', '0x10', '.5', '1.', '١٢٣',
    null, undefined, {}, [], true, NaN, Infinity,
  ]) {
    assert.equal(
      usdcAmountUnits(rejected),
      null,
      `${String(rejected)} must not produce spendable units`,
    );
  }
});

test('valid six-decimal USDC amounts parse to exact atomic units', () => {
  assert.equal(usdcAmountUnits('0.000001'), 1n);
  assert.equal(usdcAmountUnits('0.25'), 250_000n);
  assert.equal(usdcAmountUnits('1.123456'), 1_123_456n);
  assert.equal(usdcAmountUnits('1'), 1_000_000n);
  assert.equal(usdcAmountUnits('1000'), 1_000_000_000n);
  assert.equal(usdcAmountUnits(' 0.25 '), 250_000n, 'surrounding whitespace is tolerated');
  assert.equal(usdcAmountUnits(0.25), 250_000n, 'a numeric value is accepted too');
});

test('the amount helper never throws, whatever the field contains', () => {
  for (const hostile of [
    Symbol.iterator, () => {}, new Date(), 'a'.repeat(5000), '9'.repeat(40), -0,
  ]) {
    assert.doesNotThrow(() => usdcAmountUnits(hostile));
  }
});

test('the NFT ask price and vault deposit gate on the parse, not on Number()', async () => {
  const stage2 = await readFile('src/stage2-views.jsx', 'utf8');

  assert.equal(
    /disabled=\{!price \|\| Number\(price\) <= 0\}/.test(stage2),
    false,
    'the ask-price button must not gate on Number()',
  );
  assert.ok(stage2.includes('disabled={priceUnits === null}'), 'it gates on the parsed units');
  assert.ok(
    stage2.includes('args: [asset.tokenId, priceUnits]'),
    'and sends exactly the units it validated, so the guard and the call cannot disagree',
  );
  assert.equal(
    /Number\(depositAmount\) > 0/.test(stage2),
    false,
    'the vault deposit must not gate on Number() either',
  );
  assert.ok(stage2.includes('usdcAmountUnits(depositAmount)'), 'it uses the same parser');

  // Both fields are real numeric inputs with contract-precision bounds.
  const numericInputs = stage2.match(/type="number"[\s\S]{0,220}?step="0\.000001"/g) ?? [];
  assert.ok(numericInputs.length >= 2, 'ask price and deposit are both numeric with 6dp steps');
});

// ─────────────────────────────────────────────────────────────────────────────
// Site chrome must not style nested product content
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

  // The component-level semantic elements keep their own markup and their own class-scoped CSS.
  const stage3 = await readFile('src/stage3-views.jsx', 'utf8');
  assert.ok(stage3.includes('<header>'), 'TimelineEntry keeps a semantic header');
  assert.ok(stage3.includes('<footer>'), 'TimelineEntry keeps a semantic footer');
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

test('mobile navigation keeps all seven labels readable on one line', async () => {
  const css = await readFile('src/styles.css', 'utf8');
  const main = await readFile('src/main.jsx', 'utf8');

  const navItems = [...main.matchAll(/\['(0\d)', '([A-Z]+)', '(\/[a-z]*)'\]/g)];
  assert.equal(navItems.length, 7, 'there are seven primary navigation items');

  assert.ok(
    /\.site-header nav a\{[^}]*white-space:nowrap/.test(css),
    'labels must not wrap mid-word',
  );
  assert.ok(
    /\.site-header nav a\{[^}]*flex:0 0 auto/.test(css),
    'items keep their intrinsic width instead of compressing',
  );
  assert.ok(
    /\.site-header nav\{[^}]*overflow-x:auto/.test(css),
    'the mobile nav scrolls horizontally rather than clipping',
  );
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

test('inner routes carry no guided-tour card, and the dead component is fully gone', async () => {
  const main = await readFile('src/main.jsx', 'utf8');
  const stage2 = await readFile('src/stage2-views.jsx', 'utf8');
  const stage3 = await readFile('src/stage3-views.jsx', 'utf8');
  const router = await readFile('src/router.jsx', 'utf8');
  const css = await readFile('src/styles.css', 'utf8');

  // The homepage now carries the whole guided journey. Repeating it at the bottom of every inner
  // route made finished pages read like a prototype, so those cards are gone — and nothing dead is
  // left behind: no component, no import, no CSS.
  for (const [name, source] of [
    ['main.jsx', main], ['stage2-views.jsx', stage2], ['stage3-views.jsx', stage3],
    ['router.jsx', router],
  ]) {
    assert.equal(/<NextStep/.test(source), false, `${name} must not render a NextStep card`);
    assert.equal(/\bNextStep\b/.test(source), false, `${name} must not reference NextStep at all`);
  }
  assert.equal(/\.next-step/.test(css), false, 'the .next-step styles must be removed');
});

test('current-facing documentation points at the live deployment, not a local one', async () => {
  const readme = await readFile('README.md', 'utf8');
  const submission = await readFile('docs/SUBMISSION.md', 'utf8');

  // The site is deployed and public. A judge reading either document must not be told otherwise.
  for (const [name, doc] of [['README.md', readme], ['docs/SUBMISSION.md', submission]]) {
    assert.ok(doc.includes('https://memeverse.biz'), `${name} must link the live deployment`);
    for (const stale of [
      'not yet hosted', 'no hosted demo', 'No hosted demo URL exists yet',
      'is not hosted at a public URL', 'deployment pending',
    ]) {
      assert.equal(
        doc.toLowerCase().includes(stale.toLowerCase()),
        false,
        `${name} must not still claim: "${stale}"`,
      );
    }
    // And it must keep saying what is genuinely not true yet.
    assert.ok(
      /not mainnet-ready|not mainnet ready/i.test(doc),
      `${name} must keep the mainnet caveat`,
    );
  }

  const html = await readFile('index.html', 'utf8');
  assert.ok(html.includes('rel="canonical" href="https://memeverse.biz/"'), 'canonical URL');
  assert.ok(html.includes('property="og:url" content="https://memeverse.biz/"'), 'og:url');
});

test('the homepage keeps the one guided journey a judge follows', async () => {
  const main = await readFile('src/main.jsx', 'utf8');

  assert.ok(main.includes('THE THREE-MINUTE TOUR'), 'the homepage tour must remain');
  for (const step of [
    'LAUNCH A MEME', 'TRADE THE CURVE', 'OWN THE MEDIA',
    'AUTONOMOUS REWARDS', 'PROOF CENTER', 'TREASURY PRIMITIVE',
  ]) {
    assert.ok(main.includes(step), `the tour must still offer: ${step}`);
  }
  // And the five-step economy strip that frames the whole product.
  for (const step of ['CREATE', 'TRADE', 'OWN', 'REWARD', 'PROVE']) {
    assert.ok(main.includes(`'${step}'`), `the economy flow must still name ${step}`);
  }
});

test('the Stage 3 surfaces state absence rather than inventing a value', async () => {
  const stage3 = await readFile('src/stage3-views.jsx', 'utf8');

  // Explicit unavailability is the whole point of these surfaces.
  for (const required of [
    'NOT CONFIGURED', 'UNAVAILABLE', 'NO AUTONOMOUS REWARD IN THIS DEPLOYMENT YET', 'NONE YET',
  ]) {
    assert.ok(stage3.includes(required), `Stage 3 must be able to render "${required}"`);
  }

  // And no surface may claim a capability the project does not have. The words themselves are
  // allowed — the Proof Center has to be able to say "nothing here is mainnet" — so what is
  // banned is the affirmative claim.
  for (const banned of [
    'is mainnet-ready', 'now mainnet-ready', 'independently audited', 'security audited',
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
    'Arc Public Testnet MVP — not mainnet-ready',
    'No independent security audit',
    'application-level',
    'deterministic and does not use an LLM',
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

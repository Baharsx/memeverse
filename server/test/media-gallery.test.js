import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  LEGACY_HIDDEN_MEDIA_TOKEN_IDS,
  isLegacyHiddenMediaToken,
  publicMediaAssets,
} from '../../src/media-display.js';

/**
 * Creator Media gallery presentation.
 *
 * Two separate promises are defended here. One token is absent from the public grid; every token
 * remains readable from the contract. The moment those two ideas share an implementation, hiding
 * a card would start meaning deleting evidence.
 */

const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

function asset(tokenId, name) {
  return { tokenId, metadata: { name }, owner: '0x1', creator: '0x2', market: '0x3' };
}

test('the legacy genesis mint is hidden from the public gallery', () => {
  assert.deepEqual([...LEGACY_HIDDEN_MEDIA_TOKEN_IDS], [1]);
  assert.equal(isLegacyHiddenMediaToken(1), true);
  assert.equal(isLegacyHiddenMediaToken(1n), true, 'a BigInt token id from viem must match');
  assert.equal(isLegacyHiddenMediaToken('1'), true, 'a string token id must match');
});

test('the current and any future media stay visible', () => {
  for (const id of [2, 2n, '2', 3, 17, 999n]) {
    assert.equal(isLegacyHiddenMediaToken(id), false, String(id));
  }
  const collection = [
    asset(1n, 'MemeVerse Genesis Mark'),
    asset(2n, 'Nice Cat Genesis'),
    asset(3n, 'A Later Mint'),
  ];
  assert.deepEqual(
    publicMediaAssets(collection).map((entry) => entry.metadata.name),
    ['Nice Cat Genesis', 'A Later Mint'],
  );
  // The enumeration handed in is never mutated: it still describes the whole collection.
  assert.equal(collection.length, 3);
  assert.equal(collection[0].tokenId, 1n);
});

test('hiding is by token id, never by name, creator, owner, or market', () => {
  // A later token that happens to reuse the old name must still appear.
  const impostor = asset(9n, 'MemeVerse Genesis Mark');
  assert.deepEqual(publicMediaAssets([impostor]), [impostor]);
  // And token 1 stays hidden whatever it is called or who holds it.
  const renamed = { ...asset(1n, 'Something Else'), owner: '0xdead', creator: '0xbeef' };
  assert.deepEqual(publicMediaAssets([renamed]), []);
});

test('a malformed collection cannot throw into the gallery', () => {
  assert.deepEqual(publicMediaAssets(undefined), []);
  assert.deepEqual(publicMediaAssets(null), []);
  assert.deepEqual(publicMediaAssets([]), []);
  assert.equal(publicMediaAssets([{}]).length, 1, 'an id-less row is a data problem, not a hidden token');
  for (const value of [undefined, null, '', {}, []]) {
    assert.equal(isLegacyHiddenMediaToken(value), false);
  }
});

test('the low-level contract enumeration is left completely alone', async () => {
  // `readMediaAssets()` reads the collection from Arc. If it ever learned about this list, the
  // gallery filter would stop being a presentation concern and start hiding onchain truth from
  // audits and from the mint provenance check.
  const assets = await source('../../src/assets.js');
  for (const forbidden of [
    'LEGACY_HIDDEN_MEDIA_TOKEN_IDS', 'isLegacyHiddenMediaToken', 'publicMediaAssets',
  ]) {
    assert.equal(assets.includes(forbidden), false, `src/assets.js must not filter: ${forbidden}`);
  }
  // It still enumerates every token from 1 to totalMinted.
  assert.ok(/totalMinted/.test(assets), 'the reader still asks the contract how many exist');

  const views = await source('../../src/stage2-views.jsx');
  assert.ok(views.includes('publicMediaAssets(assets.data?.assets)'), 'the gallery filters the read result');
  assert.equal(
    /assets\.data\.assets\.(map|length)/.test(views),
    false,
    'the grid must not render straight from the unfiltered enumeration',
  );
});

test('the filter never reaches the backend, the agent, or the audits', async () => {
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
  const files = (await Promise.all(['../../server', '../../scripts'].map(walk))).flat()
    .filter((path) => !path.includes('/test/'));
  assert.ok(files.length > 20);
  for (const path of files) {
    const text = await source(path);
    for (const forbidden of [
      'LEGACY_HIDDEN_MEDIA_TOKEN_IDS', 'isLegacyHiddenMediaToken', 'publicMediaAssets',
    ]) {
      assert.equal(text.includes(forbidden), false, `${path}: ${forbidden}`);
    }
  }
});

/**
 * Marketplace intent.
 *
 * The panel that lists a token and the panel that buys one looked nearly identical, and `list()`
 * was labelled in a way that could be read as a completed sale. These assertions pin the wording
 * that makes the two sides unambiguous.
 */

test('the seller panel says SELL and never calls listing a sale', async () => {
  const views = await source('../../src/stage2-views.jsx');
  assert.ok(views.includes('MARKETPLACE ACTION // SELL'), 'the owner panel names its side');
  assert.ok(views.includes('2. LIST FOR SALE →'), 'the listing button says what it does');
  assert.ok(views.includes('1. APPROVE MARKETPLACE'), 'the seller still approves first');
  // `list()` offers a token; it does not sell one.
  assert.ok(views.includes('label="LIST FOR SALE"'), 'the listing transaction is labelled honestly');
  assert.equal(views.includes('label="SELL"'), false, 'no listing transaction may be called a SELL');
});

test('the buyer panel says BUY and always carries the live price', async () => {
  const views = await source('../../src/stage2-views.jsx');
  assert.ok(views.includes('MARKETPLACE ACTION // BUY'), 'the buyer panel names its side');
  assert.ok(views.includes('1. APPROVE {listing.priceUsdc} USDC'), 'approval states the amount');
  assert.ok(views.includes('BUY FOR {listing.priceUsdc} USDC →'), 'the buy label carries the price');
  assert.ok(views.includes('<TxStatus state={buy.state} label="BUY" />'), 'the buy transaction stays BUY');
});

test('the BUY label comes from listing data, so allowance changes cannot blank it', async () => {
  const views = await source('../../src/stage2-views.jsx');
  const buyer = views.slice(views.indexOf('{/* Buyer actions */}'), views.indexOf('function MintMedia'));

  // Only `disabled` may depend on the allowance query; the label may not.
  assert.ok(/disabled=\{\(allowance\.data \?\? 0n\) < listing\.priceUnits\}/.test(buyer),
    'allowance decides only whether the button is disabled');
  const label = /BUY FOR \{([^}]+)\} USDC/.exec(buyer);
  assert.ok(label, 'the buy label exists');
  assert.equal(label[1].includes('allowance'), false, 'the label must not read the allowance query');
  // An undefined allowance falls back to 0n rather than producing NaN or undefined comparisons.
  assert.ok(buyer.includes('allowance.data ?? 0n'), 'a pending allowance fails closed at zero');

  // A rejected wallet prompt must not become an unhandled rejection.
  assert.ok(buyer.includes('} catch {'), 'the approval handler catches a declined prompt');
});

test('an owner is never shown buyer controls, and vice versa', async () => {
  const views = await source('../../src/stage2-views.jsx');
  assert.ok(views.includes('{isOwner && !listing ? ('), 'the sell panel requires ownership');
  assert.ok(views.includes('{isOwner && listing ? ('), 'the cancel panel requires ownership');
  assert.ok(views.includes('{!isOwner && listing?.fillable && wallet.isConnected ? ('),
    'the buy panel requires a connected non-owner and a fillable listing');
});

/**
 * The disabled primary button.
 *
 * `.coin-row button,.nft-card button{background:none}` at (0,1,1) outranks `.primary` at (0,1,0),
 * so inside a media card the primary button lost its fill while keeping near-black text — an
 * invisible label on a dark card. These assertions keep the repair in place.
 */

test('a media-card primary button keeps an explicit readable foreground and fill', async () => {
  const css = await source('../../src/styles.css');
  assert.ok(css.includes('.nft-card .btn.primary{background:var(--acid);border-color:var(--acid);color:var(--bg)}'),
    'the enabled primary button is restored inside a media card');
  assert.ok(/\.nft-card \.btn\{[^}]*color:var\(--ink\)/.test(css),
    'a non-primary card button states its own foreground');
});

test('a disabled primary button stays legible instead of fading away', async () => {
  const css = await source('../../src/styles.css');
  const rule = /\.nft-card \.btn\.primary:disabled,\.btn\.primary:disabled\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the disabled primary treatment exists');
  const body = rule[1].replace(/\s/g, '');
  assert.ok(body.includes('color:var(--acid)'), 'an explicit readable foreground');
  assert.ok(body.includes('opacity:1'), 'never faded toward the background');
  assert.ok(body.includes('cursor:not-allowed'), 'the cursor says it is not clickable');
  assert.ok(body.includes('box-shadow:none') && body.includes('transform:none'), 'no active affordance');
});

test('hovering a disabled button does not animate it', async () => {
  const css = await source('../../src/styles.css');
  const rule = /\.btn:disabled:hover,[^{]*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'a disabled hover rule exists');
  assert.ok(rule[1].includes('transform:none'), 'no lift');
  assert.ok(rule[1].includes('box-shadow:none'), 'no shadow');
});

test('marketplace side is conveyed as text, not by colour alone', async () => {
  const css = await source('../../src/styles.css');
  assert.ok(/\.marketplace-mode\{/.test(css), 'the mode label is styled');
  const views = await source('../../src/stage2-views.jsx');
  // Both labels spell out the action, so the distinction survives without colour perception.
  assert.ok(views.includes('MARKETPLACE ACTION // BUY'));
  assert.ok(views.includes('MARKETPLACE ACTION // SELL'));
});

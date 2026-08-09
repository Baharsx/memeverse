import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { arcTestnet as reownPublishedArcTestnet } from '@reown/appkit/networks';
import { arcTestnet as viemArcTestnet } from 'viem/chains';
import { ARC_FALLBACK_RPC_URL, ARC_RPC_URL, arc } from '../../src/arc.js';
import {
  ARC_TESTNET_CHAIN_ID,
  MEMEVERSE_ORIGIN,
  RESTRICTED_BROWSER_HINT,
  isRestrictedEmbeddedBrowser,
  reownAppKitConfigured,
  reownAppKitFeatures,
  reownAppKitMetadata,
  reownAppKitTheme,
  reownArcCaipNetworkId,
  reownArcNetwork,
  reownCustomRpcUrls,
  reownProjectId,
  shortWalletAddress,
  walletButtonLabel,
} from '../../src/wallet-connection.js';

/**
 * Wallet connection.
 *
 * The bug these guard against was not a rendering mistake: the browser had exactly one way to
 * reach a wallet — an injected EIP-1193 provider — and an ordinary mobile browser does not have
 * one. So the properties asserted here are the ones that decide whether a phone can connect at
 * all: that a WalletConnect path exists, that the button offers it instead of announcing failure,
 * that the chain offered is Arc and only Arc, and that the modal is a wallet connector rather than
 * a second authentication product.
 *
 * "Reown AppKit" throughout is the WalletConnect wallet modal. It is not Circle App Kit.
 */

/* ── The chain ─────────────────────────────────────────────────────────────── */

test('the Reown network, the project Arc definition, and viem all name chain 5042002', () => {
  // The single invariant the whole wallet layer rests on. If these ever disagree, a wallet is
  // being asked to approve a chain the application does not trade on.
  assert.equal(ARC_TESTNET_CHAIN_ID, 5042002);
  assert.equal(arc.id, ARC_TESTNET_CHAIN_ID);
  assert.equal(reownArcNetwork.id, ARC_TESTNET_CHAIN_ID);
  assert.equal(viemArcTestnet.id, ARC_TESTNET_CHAIN_ID);
  assert.equal(reownPublishedArcTestnet.id, ARC_TESTNET_CHAIN_ID, 'Reown publishes the same id');
  assert.equal(reownArcCaipNetworkId, 'eip155:5042002');
});

test('the wallet layer reuses the existing Arc definition rather than a second copy of it', () => {
  // Not a deep-equal: the same object. A copy is what lets an RPC URL, an explorer, or a currency
  // drift on one side of the app and not the other.
  assert.equal(reownArcNetwork, arc, 'the Reown network must be the project Arc object itself');
  assert.equal(reownArcNetwork.nativeCurrency.symbol, 'USDC');
  assert.equal(reownArcNetwork.blockExplorers.default.url, 'https://testnet.arcscan.app');
});

test('AppKit is told to use MemeVerse Arc endpoints, not an unrelated RPC', () => {
  const urls = reownCustomRpcUrls[reownArcCaipNetworkId].map((entry) => entry.url);
  assert.deepEqual(urls, [ARC_RPC_URL, ARC_FALLBACK_RPC_URL]);
  // Reown's Blockchain API does not serve Arc, so nothing of theirs may appear here.
  for (const url of urls) {
    assert.ok(url.includes('arc.io'), `${url} must be an Arc endpoint`);
    assert.equal(url.includes('walletconnect'), false);
  }
});

/* ── Identity presented to the wallet ──────────────────────────────────────── */

test('the wallet is shown the real MemeVerse origin', () => {
  assert.equal(MEMEVERSE_ORIGIN, 'https://memeverse.biz');
  assert.equal(reownAppKitMetadata.url, 'https://memeverse.biz');
  assert.equal(reownAppKitMetadata.name, 'MemeVerse');
  assert.equal(reownAppKitMetadata.description, 'A meme becomes an economy on Arc.');
  // A relative icon renders as a broken image in the wallet's approval sheet.
  assert.equal(reownAppKitMetadata.icons.length, 1);
  assert.ok(reownAppKitMetadata.icons[0].startsWith('https://memeverse.biz/'));
  assert.ok(reownAppKitMetadata.icons[0].endsWith('memeverse-mark.png'));
});

/* ── The modal is a connector, not an auth product ─────────────────────────── */

test('email, social login, swaps, and on-ramp are all off', () => {
  assert.equal(reownAppKitFeatures.email, false);
  assert.equal(reownAppKitFeatures.socials, false);
  assert.equal(reownAppKitFeatures.swaps, false);
  assert.equal(reownAppKitFeatures.onramp, false);
  assert.equal(reownAppKitFeatures.emailShowWallets, false);
});

test('wallet connection itself stays fully enabled', () => {
  assert.equal(reownAppKitFeatures.allWallets, true);
  assert.equal(reownAppKitTheme.themeMode, 'dark');
  assert.equal(reownAppKitTheme.themeVariables['--w3m-accent'], '#C6F432', 'MemeVerse lime');
});

test('the AppKit call keeps the whole wallet catalogue and every external transport', async () => {
  const source = await readFile(new URL('../../src/reown-appkit.js', import.meta.url), 'utf8');
  assert.match(source, /allWallets:\s*'SHOW'/, 'the All Wallets view must stay available');
  for (const flag of ['enableWalletConnect', 'enableInjected', 'enableEIP6963', 'enableCoinbase']) {
    assert.match(source, new RegExp(`${flag}:\\s*true`), `${flag} must stay on`);
  }
  // A hard-coded shortlist would silently exclude whichever wallet a visitor actually owns.
  assert.equal(source.includes('includeWalletIds'), false);
  assert.equal(source.includes('featuredWalletIds'), false);
});

test('AppKit is constructed at module scope, never inside a component or an effect', async () => {
  const source = await readFile(new URL('../../src/reown-appkit.js', import.meta.url), 'utf8');
  // Constructed once, at import time. Building it during render would re-register connectors on
  // every pass and hand Wagmi a different config than the one it mounted with.
  assert.match(source, /^export const wagmiAdapter = /m);
  assert.match(source, /^export const reownAppKit = /m);
  // Matched as calls and imports rather than as words, so prose about hooks cannot fail this.
  assert.equal(/\buseEffect\(|\buseState\(/.test(source), false);
  assert.equal(/from 'react'/.test(source), false, 'this module must not be a React module');

  const main = await readFile(new URL('../../src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /<WagmiProvider config=\{wagmiConfig\}>/, 'the adapter config must be the one React uses');
  assert.equal(main.includes('createConfig('), false, 'main.jsx must not build a second Wagmi config');
});

test('the Arc transport keeps its primary-then-fallback shape', async () => {
  const source = await readFile(new URL('../../src/reown-appkit.js', import.meta.url), 'utf8');
  assert.match(source, /fallback\(\[http\(ARC_RPC_URL\), http\(ARC_FALLBACK_RPC_URL\)\]\)/);
  assert.match(source, /transports: arcTransports/);
});

/* ── The button ────────────────────────────────────────────────────────────── */

test('a disconnected wallet always reads CONNECT WALLET', () => {
  assert.equal(walletButtonLabel({}), 'CONNECT WALLET');
  assert.equal(walletButtonLabel({ isConnected: false }), 'CONNECT WALLET');
  // The whole mobile bug in one assertion: no injected provider is not a broken wallet, it is the
  // normal state of Safari and Chrome, and it must never be reported as unavailability.
  assert.notEqual(walletButtonLabel({}), 'WALLET UNAVAILABLE');
  assert.equal(walletButtonLabel({}).includes('UNAVAILABLE'), false);
  assert.equal(walletButtonLabel({ isConnecting: true }), 'CONNECTING…');
});

test('a connected wallet shows its address, with the balance when there is room', () => {
  const address = '0x1234567890abcdef1234567890abcdEF12345678';
  assert.equal(walletButtonLabel({ isConnected: true, address }), '0x1234…5678');
  assert.equal(
    walletButtonLabel({ isConnected: true, address, balanceLabel: '12.3456 USDC' }),
    '12.3456 USDC // 0x1234…5678',
  );
});

test('address truncation refuses anything that is not an address', () => {
  assert.equal(shortWalletAddress('0x1234567890abcdef1234567890abcdEF12345678'), '0x1234…5678');
  for (const value of [null, undefined, '', '0x', 'not-an-address', '0x1234', 42]) {
    assert.equal(shortWalletAddress(value), null, `${String(value)} is not an address`);
  }
  // An unusable address must not degrade the connected label into a broken-looking string.
  assert.equal(walletButtonLabel({ isConnected: true, address: 'nonsense' }), 'CONNECT WALLET');
});

test('the header button opens the modal and never disconnects on a tap', async () => {
  const main = await readFile(new URL('../../src/main.jsx', import.meta.url), 'utf8');
  const wallet = main.slice(main.indexOf('function Wallet()'), main.indexOf('function NetworkStatus()'));

  assert.match(wallet, /modal\.open\('Account'\)/, 'a connected tap opens the Account view');
  assert.match(wallet, /modal\.open\('Connect'\)/, 'a disconnected tap opens the Connect view');
  // The old behaviour: one stray tap on a phone ended the session with no confirmation.
  assert.equal(wallet.includes('disconnect('), false, 'the header button must not disconnect');
  assert.equal(main.includes('useDisconnect'), false, 'disconnect belongs to the Account view');
  // The rendered string, matched as a string literal so the comment explaining the old bug does
  // not count as the bug.
  assert.equal(/'WALLET UNAVAILABLE|>WALLET UNAVAILABLE/.test(main), false);
});

test('the modal is always opened in the EVM namespace on the requested view', async () => {
  const source = await readFile(new URL('../../src/reown-appkit.js', import.meta.url), 'utf8');
  assert.match(source, /open\(\{ view, namespace: 'eip155' \}\)/);
});

/* ── Restricted embedded browsers ──────────────────────────────────────────── */

test('embedded WebViews that block wallet deep links are recognised', () => {
  const restricted = [
    // Android System WebView, which is what Discord, Telegram, and Slack embed.
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/468.0]',
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Instagram 320.0.0.0 Android',
  ];
  for (const userAgent of restricted) {
    assert.equal(isRestrictedEmbeddedBrowser(userAgent), true, userAgent.slice(0, 40));
  }
});

test('ordinary mobile and desktop browsers are never warned', () => {
  const ordinary = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    // MetaMask's own in-app browser can reach wallets perfectly well.
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 MetaMaskMobile',
  ];
  for (const userAgent of ordinary) {
    assert.equal(isRestrictedEmbeddedBrowser(userAgent), false, userAgent.slice(0, 40));
  }
  for (const value of [null, undefined, '', 42]) {
    assert.equal(isRestrictedEmbeddedBrowser(value), false);
  }
});

test('the hint names a way out rather than blaming the visitor', () => {
  assert.equal(RESTRICTED_BROWSER_HINT, 'OPEN MEMEVERSE IN SAFARI / CHROME OR YOUR WALLET BROWSER');
});

test('the hint is shown only after an attempt in a browser known to block deep links', async () => {
  const main = await readFile(new URL('../../src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /showRestrictedBrowserHint: restricted && attempted/);
});

/* ── Configuration ─────────────────────────────────────────────────────────── */

test('no project id is hard-coded, invented, or committed', () => {
  // Imported outside Vite, so no VITE_* value exists and the module must resolve to "unconfigured"
  // rather than to a placeholder that would look configured in production.
  assert.equal(reownProjectId, '');
  assert.equal(reownAppKitConfigured, false);
});

test('the project id is documented in the environment template without a value', async () => {
  const example = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');
  assert.match(example, /^VITE_REOWN_PROJECT_ID=$/m, 'declared, and deliberately empty');
  assert.match(example, /dashboard\.reown\.com/);
  assert.match(example, /https:\/\/memeverse\.biz/);
});

test('the dashboard settings the code cannot enforce are written down', async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('## Wallet connection (Reown AppKit)'));
  assert.ok(section.length > 0, 'the README must document wallet connection');
  // Since AppKit 1.7 these are remote features: whatever the code asks for, a fetched dashboard
  // configuration overrides. The only place that can be fixed is the dashboard, so the only
  // honest place to record it is the README.
  assert.match(section, /Allowed origin \| `https:\/\/memeverse\.biz`/);
  for (const setting of ['Email login', 'Social login', 'Swaps', 'On-ramp']) {
    assert.match(section, new RegExp(`\\| ${setting} \\| Disabled \\|`), `${setting} must be documented as disabled`);
  }
  assert.match(section, /Reown AppKit is not Circle App Kit/);
});

test('the wallet modal never becomes the Circle App Kit integration by accident', async () => {
  for (const file of ['../../src/wallet-connection.js', '../../src/reown-appkit.js']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.equal(/circle/i.test(source.replace(/Circle App Kit|Circle wallets|Circle:|Circle\b/g, '')), false,
      `${file} must not reference Circle configuration`);
  }
});

/* ── Content Security Policy ───────────────────────────────────────────────── */

test('the policy permits the relay a mobile wallet pairs over', async () => {
  const { contentSecurityPolicyDirectives } = await import('../security/csp.js');
  const connect = contentSecurityPolicyDirectives()['connect-src'];
  assert.ok(connect.includes('wss://relay.walletconnect.org'), 'no relay means no mobile wallet');
  assert.ok(connect.includes('https://api.web3modal.org'), 'no catalogue means an empty modal');
  // The Arc endpoints the application actually transacts against are untouched.
  assert.ok(connect.includes('https://rpc.testnet.arc.io'));
  assert.ok(connect.includes('https://rpc.drpc.testnet.arc.io'));
});

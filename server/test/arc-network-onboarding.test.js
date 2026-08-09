import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ARC_CHAIN_ID_HEX,
  ARC_READ_FALLBACK_RPC_URL,
  ARC_READ_RPC_URL,
  ARC_WALLET_RPC_URL,
  arc,
} from '../../src/arc.js';
import {
  ARC_CHAIN_ID,
  ARC_MANUAL_NETWORK,
  ARC_NETWORK_ACTION,
  ARC_SWITCH_STATUS,
  arcAddEthereumChainParams,
  authorizedRequestChain,
  ensureArcNetwork,
  isUnknownChainError,
  isUserRejectedError,
  normalizeProviderError,
  arcAuthorizedForSession,
  arcNetworkAction,
} from '../../src/arc-network-onboarding.js';
import { createWalletConnectSession } from './helpers/walletconnect.js';

/**
 * Arc network onboarding.
 *
 * The production bug these are written against: a wallet connected over WalletConnect on a phone,
 * MemeVerse correctly saw the wrong network, and the switch then failed with nothing shown. The
 * cause was not the payload — it is well formed — but the *address* of the request. A
 * WalletConnect session only carries the chains the wallet approved, and both the switch and the
 * add were being sent on Arc, a chain the session did not authorise, so neither ever reached the
 * wallet.
 *
 * So the properties guarded here are: which chain each request is addressed to, that an add is
 * only attempted for a genuinely unknown chain, and — the one that decides whether money can move
 * — that success is never reported from anything except a fresh read of the wallet's chain id.
 */

/** A recording provider. Every request is captured with the chain it was addressed to. */
function mockProvider({ chainId = 1, sessionChains = null, onRequest = () => {} } = {}) {
  const calls = [];
  let current = chainId;
  return {
    calls,
    get chainId() { return current; },
    setChainId(next) { current = next; },
    session: sessionChains
      ? { namespaces: { eip155: { chains: sessionChains.map((id) => `eip155:${id}`) } } }
      : undefined,
    async request(args, chain) {
      calls.push({ method: args.method, params: args.params, chain: chain ?? null });
      if (args.method === 'eth_chainId') return `0x${current.toString(16)}`;
      const outcome = onRequest(args, chain, { setChainId: (n) => { current = n; } });
      if (outcome instanceof Error) throw outcome;
      return outcome ?? null;
    },
  };
}

test('the visible Arc CTA follows connection, chain, and session authorisation', () => {
  assert.equal(arcNetworkAction({}), ARC_NETWORK_ACTION.CONNECT);
  assert.equal(arcNetworkAction({ isConnected: true, chainId: 1, sessionAuthorized: false }), ARC_NETWORK_ACTION.ADD);
  assert.equal(arcNetworkAction({ isConnected: true, chainId: 1, sessionAuthorized: true }), ARC_NETWORK_ACTION.SWITCH);
  assert.equal(arcNetworkAction({ isConnected: true, chainId: ARC_CHAIN_ID, sessionAuthorized: false }), ARC_NETWORK_ACTION.RECONNECT);
  assert.equal(arcNetworkAction({
    isConnected: true,
    chainId: ARC_CHAIN_ID,
    sessionAuthorized: true,
  }), ARC_NETWORK_ACTION.READY);
  assert.equal(arcNetworkAction({
    isConnected: true,
    chainId: 1,
    sessionAuthorized: false,
    switchStatus: ARC_SWITCH_STATUS.SESSION_REAUTH_REQUIRED,
  }), ARC_NETWORK_ACTION.RECONNECT);
});

const run = (provider, sessionChainIds = []) => ensureArcNetwork({
  connectorId: sessionChainIds.length ? 'walletConnect' : 'injected',
  sessionChainIds,
  request: (args, chain) => provider.request(args, chain),
  readChainId: async () => Number.parseInt(await provider.request({ method: 'eth_chainId' }), 16),
});

const withCode = (code, message = 'failed') => Object.assign(new Error(message), { code });

/** Runs the production onboarding path against the faithful WalletConnect session mock. */
const runWalletConnect = (wc) => ensureArcNetwork({
  connectorId: 'walletConnect',
  sessionChainIds: wc.approvedChainIds(),
  request: (args, chain) => wc.provider.request(args, chain),
  readChainId: async () => Number.parseInt(await wc.provider.request({ method: 'eth_chainId' }), 16),
  readSessionChainIds: async () => wc.approvedChainIds(),
});

/** A representative MemeVerse wallet call, addressed to Arc. */
const arcRequest = (wc, method) => wc.provider.request({
  method,
  params: method === 'eth_sendTransaction'
    ? [{ from: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', data: '0x', value: '0x0' }]
    : ['0x68656c6c6f', '0x1111111111111111111111111111111111111111'],
}, `eip155:${ARC_CHAIN_ID}`);

/* ── H. The chain id itself ─────────────────────────────────────────────────── */

test('the chain id is 5042002 and its hex is 0x4cef52, not 0x4CF4B2', () => {
  assert.equal(ARC_CHAIN_ID, 5042002);
  assert.equal(arc.id, 5042002);
  assert.equal(ARC_CHAIN_ID_HEX, '0x4cef52');
  assert.equal(Number(ARC_CHAIN_ID_HEX), 5042002, 'hex must decode to the decimal id');
  assert.equal(Number.parseInt(ARC_CHAIN_ID_HEX, 16), ARC_CHAIN_ID);
  // The value that appears in stale material. It is a different chain entirely.
  assert.notEqual(ARC_CHAIN_ID_HEX.toLowerCase(), '0x4cf4b2');
  assert.equal(Number('0x4CF4B2'), 5043378);
});

/* ── I. The registration payload ────────────────────────────────────────────── */

test('the application read transport is the pair proven under Markets-page concurrency', () => {
  // The rollback in one assertion. Both of these answered 95/95 under a burst matching one
  // Markets page load; the canonical pair did not, and the page died with ARC RPC READ FAILED.
  assert.equal(ARC_READ_RPC_URL, 'https://rpc.testnet.arc.io');
  assert.equal(ARC_READ_FALLBACK_RPC_URL, 'https://rpc.drpc.testnet.arc.io');
  assert.deepEqual(arc.rpcUrls.default.http, [ARC_READ_RPC_URL, ARC_READ_FALLBACK_RPC_URL]);
});

test('quicknode is never the application read fallback again', () => {
  // 90 of 95 concurrent calls returned HTTP 429. As a fallback it gave viem nowhere to spill.
  const quicknode = 'https://rpc.quicknode.testnet.arc.network';
  assert.notEqual(ARC_READ_RPC_URL, quicknode);
  assert.notEqual(ARC_READ_FALLBACK_RPC_URL, quicknode);
  assert.equal(arc.rpcUrls.default.http.includes(quicknode), false);
  assert.equal(arc.rpcUrls.public.http.includes(quicknode), false);
  assert.equal(arcAddEthereumChainParams().rpcUrls.includes(quicknode), false,
    'nor is it offered to a wallet, where it would only give the wallet a way to fail');
});

test('the EIP-3085 payload uses the wallet endpoint and does not inherit the read transport', () => {
  const params = arcAddEthereumChainParams();
  assert.equal(ARC_WALLET_RPC_URL, 'https://rpc.testnet.arc.network');
  assert.deepEqual(params.rpcUrls, [ARC_WALLET_RPC_URL], 'one canonical wallet endpoint');
  assert.equal(params.chainId, '0x4cef52');
  assert.equal(params.chainName, 'Arc Testnet');
  assert.deepEqual(params.blockExplorerUrls, ['https://testnet.arcscan.app']);
  assert.ok(params.rpcUrls.every((url) => url.startsWith('https://')));

  // The coupling that caused the rollback: the payload must not be built from the chain object.
  assert.equal(params.rpcUrls.includes(ARC_READ_RPC_URL), false);
  assert.equal(params.rpcUrls.includes(ARC_READ_FALLBACK_RPC_URL), false);
  for (const url of params.rpcUrls) {
    assert.equal(arc.rpcUrls.default.http.includes(url), false,
      `${url} must not be the application read transport`);
  }
});

test('the wallet payload is built from the wallet constant, not from arc.rpcUrls', async () => {
  const source = await readFile(new URL('../../src/arc-network-onboarding.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('export function arcAddEthereumChainParams'),
    source.indexOf('/** Every place a provider hides a numeric error code'));
  assert.match(fn, /rpcUrls: \[ARC_WALLET_RPC_URL\]/);
  // Comments stripped: prose explaining the rule must not be able to break the rule.
  assert.equal(/arc\.rpcUrls/.test(codeOnly(fn)), false,
    'reading the chain object here recreates the coupling');
});

test('the exact EIP-3085 payload', () => {
  assert.deepEqual(arcAddEthereumChainParams(), {
    chainId: '0x4cef52',
    chainName: 'Arc Testnet',
    rpcUrls: ['https://rpc.testnet.arc.network'],
    blockExplorerUrls: ['https://testnet.arcscan.app'],
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  });
});

test('the payload declares the 18-decimal NATIVE currency, which is not the 6-decimal token', async () => {
  // EIP-3085 describes the chain's native gas currency, which on Arc is an 18-decimal native
  // balance; wallets reject a native currency declared with any other precision. MemeVerse's
  // money is the ERC-20 USDC contract, which is 6 decimals and is untouched by this file.
  const params = arcAddEthereumChainParams();
  assert.deepEqual(params.nativeCurrency, { name: 'USDC', symbol: 'USDC', decimals: 18 });
  assert.equal(arc.nativeCurrency.decimals, 18, 'matches the canonical chain definition');

  const market = await import('../../src/market.js').catch(() => null);
  if (market?.parseUsdc) {
    assert.equal(market.parseUsdc('1'), 1_000_000n, 'ERC-20 USDC stays 6 decimals');
  }
});

test('the manual fallback quotes settings a person can actually type in', () => {
  assert.equal(ARC_MANUAL_NETWORK.chainIdDecimal, '5042002');
  assert.equal(ARC_MANUAL_NETWORK.chainIdHex, '0x4cef52');
  assert.equal(ARC_MANUAL_NETWORK.rpcUrl, ARC_WALLET_RPC_URL);
  assert.equal(ARC_MANUAL_NETWORK.rpcUrl, 'https://rpc.testnet.arc.network');
  // A person typing this into their wallet is configuring the wallet, not this page.
  assert.notEqual(ARC_MANUAL_NETWORK.rpcUrl, ARC_READ_RPC_URL);
  assert.equal(ARC_MANUAL_NETWORK.explorer, 'https://testnet.arcscan.app');
});

/* ── Error classification ───────────────────────────────────────────────────── */

test('an unknown chain is recognised flat, nested, and in WalletConnect wording', () => {
  assert.equal(isUnknownChainError(withCode(4902)), true, 'the standard code');
  // C. MetaMask Mobile nests the real code one level down.
  assert.equal(isUnknownChainError({ code: -32603, data: { originalError: { code: 4902 } } }), true);
  assert.equal(isUnknownChainError({ cause: { code: 4902 } }), true);
  assert.equal(isUnknownChainError(new Error('Unrecognized chain ID "0x4cef52"')), true);
  // WalletConnect answers an unauthorised chain in words rather than with 4902.
  assert.equal(isUnknownChainError(new Error('Unsupported chains: eip155:5042002')), true);
  assert.equal(isUnknownChainError(new Error('Missing or invalid. request() chainId: eip155:5042002')), true);
  assert.equal(isUnknownChainError(withCode(4001, 'User rejected')), false);
  assert.equal(isUnknownChainError(null), false);
});

test('a refusal is a refusal and is never escalated into an add prompt', () => {
  assert.equal(isUserRejectedError(withCode(4001)), true);
  assert.equal(isUserRejectedError(new Error('User rejected the request')), true);
  assert.equal(isUserRejectedError({ name: 'UserRejectedRequestError', message: 'x' }), true);
  assert.equal(isUserRejectedError(withCode(4902)), false);
});

test('the diagnostic carries codes and no private data', () => {
  const d = normalizeProviderError(
    { code: -32603, message: 'Internal', data: { originalError: { code: 4902 } } },
    { connectorId: 'walletConnect', method: 'wallet_switchEthereumChain' },
  );
  assert.equal(d.connector, 'walletConnect');
  assert.equal(d.method, 'wallet_switchEthereumChain');
  assert.equal(d.code, -32603);
  assert.equal(d.nestedCode, 4902);
  assert.ok(d.shortMessage.length <= 160);
  assert.equal(Object.keys(d).length, 5, 'no address, session topic, or project id may be added');
});

/* ── Request addressing ─────────────────────────────────────────────────────── */

test('a request is addressed to a chain the session actually authorises', () => {
  assert.equal(authorizedRequestChain({ sessionChainIds: [] }), undefined, 'injected: no addressing');
  assert.equal(authorizedRequestChain({ sessionChainIds: [5042002] }), 'eip155:5042002');
  // The whole fix: Arc is not in the session, so the request goes out on a chain that is.
  assert.equal(authorizedRequestChain({ sessionChainIds: [1, 137] }), 'eip155:1');
});

/* ── A. The wallet already has Arc ──────────────────────────────────────────── */

test('A: a wallet that knows Arc switches, and the switch is confirmed by a re-read', async () => {
  const provider = mockProvider({
    chainId: 1,
    sessionChains: [1, 5042002],
    onRequest: (args, _chain, ctl) => {
      if (args.method === 'wallet_switchEthereumChain') { ctl.setChainId(5042002); return null; }
      return null;
    },
  });
  const result = await run(provider, [1, 5042002]);
  assert.equal(result.ok, true);
  assert.equal(result.status, ARC_SWITCH_STATUS.ON_ARC);
  assert.equal(provider.calls.filter((c) => c.method === 'wallet_addEthereumChain').length, 0,
    'a wallet that has Arc must never be asked to add it');
  const [first] = provider.calls;
  assert.equal(first.method, 'wallet_switchEthereumChain');
  assert.deepEqual(first.params, [{ chainId: '0x4cef52' }]);
});

/* ── B/C/F. WalletConnect: unknown Arc, added, and the session question ─────── */

test('B: an unknown chain is added with the exact canonical params, on an authorised chain', async () => {
  const wc = createWalletConnectSession({ approvedChains: [1], emitsSessionUpdate: true });
  const result = await runWalletConnect(wc);
  assert.equal(result.ok, true);
  assert.equal(result.status, ARC_SWITCH_STATUS.ON_ARC);

  const add = wc.walletRequests.find((c) => c.method === 'wallet_addEthereumChain');
  assert.ok(add, 'the wallet must actually receive the add request');
  assert.deepEqual(add.params, [arcAddEthereumChainParams()]);
  assert.deepEqual(add.params[0].rpcUrls, ['https://rpc.testnet.arc.network']);
  // The defect in one assertion: addressed to a chain the session authorises, or sign-client
  // rejects it locally and the wallet never shows a prompt at all.
  assert.equal(add.chainId, 'eip155:1');
});

test('C: MetaMask Mobile nesting 4902 under data.originalError still triggers the add', async () => {
  // The helper's wallet answers an unknown chain with exactly that nesting.
  const wc = createWalletConnectSession({ approvedChains: [1], emitsSessionUpdate: true });
  const result = await runWalletConnect(wc);
  assert.equal(result.ok, true, 'the nested code must not be mistaken for an unrelated failure');
  assert.ok(wc.walletRequests.some((c) => c.method === 'wallet_addEthereumChain'));
});

test('F: every WalletConnect request is addressed to a chain the session authorises', async () => {
  const wc = createWalletConnectSession({ approvedChains: [1, 137], emitsSessionUpdate: true });
  await runWalletConnect(wc);
  for (const call of wc.walletRequests) {
    assert.equal(call.chainId, 'eip155:1', `${call.method} must reach the wallet on an authorised chain`);
  }
});

/* ── D. The add is rejected ─────────────────────────────────────────────────── */

test('D: a rejected add leaves the wallet on the wrong network, with a usable message', async () => {
  const provider = mockProvider({
    chainId: 1,
    sessionChains: [1],
    onRequest: (args) => {
      if (args.method === 'wallet_switchEthereumChain') return withCode(4902);
      if (args.method === 'wallet_addEthereumChain') return withCode(4001, 'User rejected the request');
      return null;
    },
  });
  const result = await run(provider, [1]);
  assert.equal(result.ok, false, 'writes must stay disabled');
  assert.equal(result.status, ARC_SWITCH_STATUS.REJECTED);
  assert.equal(result.message, 'ARC NETWORK SWITCH REJECTED');
  assert.equal(provider.chainId, 1, 'the wallet is still on its original chain');
  assert.equal(result.diagnostic.code, 4001);
  assert.ok(!/\n/.test(result.message), 'no stack trace reaches the interface');
});

test('D2: an add that fails for a reason other than refusal says so distinctly', async () => {
  const provider = mockProvider({
    chainId: 1,
    sessionChains: [1],
    onRequest: (args) => {
      if (args.method === 'wallet_switchEthereumChain') return withCode(4902);
      if (args.method === 'wallet_addEthereumChain') return withCode(-32602, 'Invalid parameters');
      return null;
    },
  });
  const result = await run(provider, [1]);
  assert.equal(result.ok, false);
  assert.equal(result.status, ARC_SWITCH_STATUS.ADD_FAILED);
  assert.equal(result.message, 'ARC NETWORK COULD NOT BE ADDED');
});

/* ── E. The add resolves but the wallet never moved ─────────────────────────── */

test('E: an add that resolves while the wallet stays put is NOT success', async () => {
  // The most dangerous case: every call resolves, and the wallet is still on mainnet. Reporting
  // success here would enable signing against the wrong network.
  const provider = mockProvider({
    chainId: 1,
    sessionChains: [1],
    onRequest: (args) => (args.method === 'wallet_switchEthereumChain' ? withCode(4902) : null),
  });
  const result = await run(provider, [1]);
  assert.equal(result.ok, false, 'a resolved add is not proof of anything');
  assert.equal(result.status, ARC_SWITCH_STATUS.STILL_WRONG_NETWORK);
  assert.equal(result.message, 'WALLET DID NOT SWITCH TO ARC');
  assert.equal(provider.chainId, 1);
});

test('E2: a switch that resolves while the wallet stays put is NOT success either', async () => {
  const provider = mockProvider({ chainId: 1, sessionChains: [1, 5042002], onRequest: () => null });
  const result = await run(provider, [1, 5042002]);
  assert.equal(result.ok, false);
  assert.equal(result.status, ARC_SWITCH_STATUS.STILL_WRONG_NETWORK);
});

test('E3: a wallet that refuses the switch but is already on Arc is reported as on Arc', async () => {
  // The read decides, not the error. Some wallets answer "already on that chain" with a rejection.
  const provider = mockProvider({
    chainId: 5042002,
    sessionChains: [1, 5042002],
    onRequest: (args) => (args.method === 'wallet_switchEthereumChain' ? withCode(4001, 'User rejected') : null),
  });
  const result = await run(provider, [1, 5042002]);
  assert.equal(result.ok, true);
  assert.equal(result.status, ARC_SWITCH_STATUS.ON_ARC);
});

/* ── F. WalletConnect specifics ─────────────────────────────────────────────── */

/** Strips block and line comments so a rule about *code* is not satisfied or broken by prose. */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('F2: nothing in the switch path touches window.ethereum', async () => {
  const source = await readFile(new URL('../../src/arc-network-onboarding.js', import.meta.url), 'utf8');
  const hook = await readFile(new URL('../../src/use-arc-network.js', import.meta.url), 'utf8');
  for (const [name, text] of [['arc-network-onboarding.js', source], ['use-arc-network.js', hook]]) {
    assert.equal(/window\.ethereum/.test(codeOnly(text)), false, `${name} must use the session provider`);
  }
  // The provider comes from the connector of the current session.
  assert.match(hook, /active\.getProvider\(\)/);
  assert.match(hook, /provider\?\.session\?\.namespaces\?\.eip155\?\.chains/);
});

test('F3: no wallet-specific deep links or URL schemes are hand-rolled', async () => {
  const source = await readFile(new URL('../../src/arc-network-onboarding.js', import.meta.url), 'utf8');
  for (const scheme of ['metamask:', 'trust:', 'rainbow:', 'cbwallet:', 'wc:']) {
    assert.equal(source.includes(scheme), false, `${scheme} must be left to Reown`);
  }
});

/* ── G. Injected desktop ────────────────────────────────────────────────────── */

test('G: an injected wallet is not addressed to a chain and still works', async () => {
  let added = false;
  const provider = mockProvider({
    chainId: 1,
    sessionChains: null, // no WalletConnect session
    onRequest: (args, _chain, ctl) => {
      if (args.method === 'wallet_switchEthereumChain') {
        if (!added) return withCode(4902);
        ctl.setChainId(5042002);
        return null;
      }
      if (args.method === 'wallet_addEthereumChain') { added = true; return null; }
      return null;
    },
  });
  const result = await run(provider, []);
  assert.equal(result.ok, true);
  for (const call of provider.calls) {
    assert.equal(call.chain, null, 'an injected provider must not be handed a CAIP chain');
  }
});

test('G2: an injected wallet already on Arc switches with one call', async () => {
  const provider = mockProvider({ chainId: 5042002, sessionChains: null, onRequest: () => null });
  const result = await run(provider, []);
  assert.equal(result.ok, true);
  assert.equal(result.status, ARC_SWITCH_STATUS.ON_ARC);
});

/* ── J. The write guards this all exists to protect ─────────────────────────── */

test('J: every write path still gates on the wallet real chain', async () => {
  const main = await readFile(new URL('../../src/main.jsx', import.meta.url), 'utf8');
  const hook = await readFile(new URL('../../src/use-arc-network.js', import.meta.url), 'utf8');
  assert.match(hook, /const onChain = isConnected && chainId === arc\.id/);
  assert.match(hook, /onArc: onChain && sessionAuthorized/,
    'being on Arc is not enough: the session must be able to carry an Arc request');
  assert.match(hook, /const \{ address, chainId, isConnected, connector \} = useAccount\(\)/,
    'the guard must read the connection chain, not the config default');
  // The four surfaces that can move money still read the same single answer.
  assert.equal((main.match(/useArcNetwork\(\)/g) ?? []).length >= 4, true);
  assert.equal(main.includes('useChainId'), false, 'useChainId cannot see an unsupported chain');
  const stage2 = await readFile(new URL('../../src/stage2-views.jsx', import.meta.url), 'utf8');
  assert.match(stage2, /return useArcNetwork\(\)/);
});

test('J2: the control reports a failure instead of silently discarding it', async () => {
  const main = await readFile(new URL('../../src/main.jsx', import.meta.url), 'utf8');
  const status = main.slice(main.indexOf('function NetworkStatus()'), main.indexOf('function BackendStatus()'));
  assert.match(status, /await arcSwitch\.switchToArc\(\)/, 'the result must be awaited, not dropped');
  assert.match(status, /className="network-error"/);
  assert.equal(/switchChain\(\{ chainId: arc\.id \}\)/.test(status), false,
    'the fire-and-forget call is what left the user stuck');
});

/* ── Phase 3–6. The session, and whether it can actually transact on Arc ─────
   Being on Arc is necessary and, over WalletConnect, not sufficient. sign-client validates every
   request against the session before it reaches the relay, so a wallet can hold Arc, report Arc,
   and still be unable to sign a single Arc transaction. These pin that distinction down. */

test('K/L: a wallet that updates the session can then transact and sign on Arc', async () => {
  const wc = createWalletConnectSession({ approvedChains: [1], emitsSessionUpdate: true });
  assert.deepEqual(wc.sessionChains(), ['eip155:1'], 'INITIAL APPROVED CHAINS');

  const result = await runWalletConnect(wc);
  assert.equal(result.ok, true);
  assert.equal(result.status, ARC_SWITCH_STATUS.ON_ARC);
  assert.deepEqual(wc.sessionChains(), ['eip155:1', 'eip155:5042002'], 'AFTER ARC ONBOARDING');

  // K: a real transaction request, addressed to Arc, passes the permission layer.
  const hash = await arcRequest(wc, 'eth_sendTransaction');
  assert.match(String(hash), /^0x[0-9a-f]+$/i);
  // L: and a signature.
  for (const method of ['personal_sign', 'eth_signTypedData_v4']) {
    const signature = await arcRequest(wc, method);
    assert.match(String(signature), /^0x[0-9a-f]+$/i, `${method} must reach the wallet`);
  }
  const sawArc = wc.walletRequests.filter((c) => c.chainId === `eip155:${ARC_CHAIN_ID}`);
  assert.ok(sawArc.length >= 3, 'the wallet received the Arc-addressed requests');
});

test('K/L: a wallet that does NOT update the session is not reported as ready', async () => {
  // The common case, and the one the previous fix got wrong: the wallet adds Arc and switches to
  // it, `eth_chainId` reports Arc — and every Arc request is still rejected locally by
  // sign-client, because only the wallet can put a chain into a live session.
  const wc = createWalletConnectSession({ approvedChains: [1], emitsSessionUpdate: false });
  assert.deepEqual(wc.sessionChains(), ['eip155:1'], 'INITIAL APPROVED CHAINS');

  const result = await runWalletConnect(wc);
  assert.deepEqual(wc.sessionChains(), ['eip155:1'], 'AFTER ARC ONBOARDING: unchanged');
  assert.equal(wc.walletHasArc(), true, 'the wallet did add Arc');
  assert.equal(
    Number.parseInt(await wc.provider.request({ method: 'eth_chainId' }), 16), ARC_CHAIN_ID,
    'and the provider reports Arc — which is exactly why this cannot be the test',
  );

  assert.equal(result.ok, false, 'this session cannot sign on Arc, so it is not success');
  assert.equal(result.status, ARC_SWITCH_STATUS.SESSION_REAUTH_REQUIRED);
  assert.equal(result.message, 'RECONNECT WALLET TO FINISH ARC SETUP');

  await assert.rejects(
    () => arcRequest(wc, 'eth_sendTransaction'),
    /Missing or invalid\. request\(\) chainId: eip155:5042002/,
    'proof that reporting success here would have enabled a failing buy',
  );
  await assert.rejects(() => arcRequest(wc, 'personal_sign'), /Missing or invalid/);
});

test('a reconnect after the wallet has Arc yields a session that can transact', async () => {
  // The supported remedy: not a hand-edited session, but a new one. By then the wallet knows Arc,
  // so it approves the chain AppKit asks for.
  const reconnected = createWalletConnectSession({ approvedChains: [1, ARC_CHAIN_ID], walletKnowsArc: true });
  assert.ok(reconnected.sessionChains().includes(`eip155:${ARC_CHAIN_ID}`));

  const result = await runWalletConnect(reconnected);
  assert.equal(result.ok, true);
  assert.equal(result.status, ARC_SWITCH_STATUS.ON_ARC);
  assert.match(String(await arcRequest(reconnected, 'eth_sendTransaction')), /^0x/);
});

test('session authorisation is required for WalletConnect and assumed for injected', () => {
  assert.equal(arcAuthorizedForSession([]), true, 'an injected wallet has no session');
  assert.equal(arcAuthorizedForSession([1]), false);
  assert.equal(arcAuthorizedForSession([1, ARC_CHAIN_ID]), true);
  assert.equal(arcAuthorizedForSession(null), true);
});

test('the write guard and the control both understand an unauthorised session', async () => {
  const hook = await readFile(new URL('../../src/use-arc-network.js', import.meta.url), 'utf8');
  // onArc gates writes, and it now requires the session too.
  assert.match(hook, /onArc: onChain && sessionAuthorized/);
  assert.match(hook, /readSessionChainIds: async \(\) => sessionChainIdsOf\(await active\.getProvider\(\)\)/);

  const main = await readFile(new URL('../../src/main.jsx', import.meta.url), 'utf8');
  const status = main.slice(main.indexOf('function NetworkStatus()'), main.indexOf('function BackendStatus()'));
  assert.match(status, /ARC_SWITCH_STATUS\.SESSION_REAUTH_REQUIRED/);
  assert.match(status, /RECONNECT WALLET/);
  // The reconnect must go through the supported disconnect + AppKit connect flow.
  assert.match(status, /await disconnectAsync\(\)/);
  assert.match(status, /openWalletModal\('Connect'\)/);
  // Never by editing a live session.
  assert.equal(/session\.namespaces\s*=/.test(codeOnly(main)), false);
  assert.equal(/namespaces\.eip155\.chains\.push/.test(codeOnly(main)), false);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ARC_CHAIN_ID_HEX, ARC_RPC_URL, ARC_FALLBACK_RPC_URL, arc } from '../../src/arc.js';
import {
  ARC_CHAIN_ID,
  ARC_MANUAL_NETWORK,
  ARC_SWITCH_STATUS,
  arcAddEthereumChainParams,
  authorizedRequestChain,
  ensureArcNetwork,
  isUnknownChainError,
  isUserRejectedError,
  normalizeProviderError,
} from '../../src/arc-network-onboarding.js';

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

const run = (provider, sessionChainIds = []) => ensureArcNetwork({
  connectorId: sessionChainIds.length ? 'walletConnect' : 'injected',
  sessionChainIds,
  request: (args, chain) => provider.request(args, chain),
  readChainId: async () => Number.parseInt(await provider.request({ method: 'eth_chainId' }), 16),
});

const withCode = (code, message = 'failed') => Object.assign(new Error(message), { code });

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

test('the EIP-3085 payload names the canonical Arc endpoints', () => {
  const params = arcAddEthereumChainParams();
  assert.equal(params.chainId, '0x4cef52');
  assert.equal(params.chainName, 'Arc Testnet');
  assert.deepEqual(params.blockExplorerUrls, ['https://testnet.arcscan.app']);
  assert.ok(params.rpcUrls.length > 0, 'an empty rpcUrls is rejected by every wallet');
  assert.equal(params.rpcUrls[0], 'https://rpc.testnet.arc.network');
  for (const url of params.rpcUrls) {
    assert.ok(url.startsWith('https://'), `${url} must be https`);
    assert.ok(url.endsWith('.arc.network'), `${url} must be a canonical Arc endpoint`);
  }
  assert.deepEqual(params.rpcUrls, [ARC_RPC_URL, ARC_FALLBACK_RPC_URL]);
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
  assert.equal(ARC_MANUAL_NETWORK.rpcUrl, 'https://rpc.testnet.arc.network');
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

/* ── B. Arc unknown → add → switch → verify ─────────────────────────────────── */

test('B: an unknown chain is added with the exact canonical params, then switched and verified', async () => {
  let added = false;
  const provider = mockProvider({
    chainId: 1,
    sessionChains: [1],
    onRequest: (args, _chain, ctl) => {
      if (args.method === 'wallet_switchEthereumChain') {
        if (!added) return withCode(4902, 'Unrecognized chain ID');
        ctl.setChainId(5042002);
        return null;
      }
      if (args.method === 'wallet_addEthereumChain') { added = true; return null; }
      return null;
    },
  });
  const result = await run(provider, [1]);
  assert.equal(result.ok, true);
  assert.equal(result.status, ARC_SWITCH_STATUS.ON_ARC);

  const add = provider.calls.find((c) => c.method === 'wallet_addEthereumChain');
  assert.ok(add, 'the wallet must be asked to add Arc');
  assert.deepEqual(add.params, [arcAddEthereumChainParams()]);
  assert.deepEqual(add.params[0].rpcUrls, ['https://rpc.testnet.arc.network', 'https://rpc.quicknode.testnet.arc.network']);
  // The defect in one assertion: this request has to go out on a chain the session authorises,
  // or WalletConnect drops it and the wallet never shows a prompt at all.
  assert.equal(add.chain, 'eip155:1');
});

/* ── C. MetaMask Mobile's nested 4902 ───────────────────────────────────────── */

test('C: MetaMask Mobile nesting 4902 under data.originalError still triggers the add', async () => {
  let added = false;
  const provider = mockProvider({
    chainId: 1,
    sessionChains: [1],
    onRequest: (args, _chain, ctl) => {
      if (args.method === 'wallet_switchEthereumChain') {
        if (!added) {
          return Object.assign(new Error('Internal JSON-RPC error.'), {
            code: -32603, data: { originalError: { code: 4902, message: 'Unrecognized chain ID' } },
          });
        }
        ctl.setChainId(5042002);
        return null;
      }
      if (args.method === 'wallet_addEthereumChain') { added = true; return null; }
      return null;
    },
  });
  const result = await run(provider, [1]);
  assert.equal(result.ok, true, 'the nested code must not be mistaken for an unrelated failure');
  assert.ok(provider.calls.some((c) => c.method === 'wallet_addEthereumChain'));
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

test('F: a WalletConnect session that omits Arc goes straight to add, on an authorised chain', async () => {
  let added = false;
  const provider = mockProvider({
    chainId: 1,
    sessionChains: [1, 137],
    onRequest: (args, _chain, ctl) => {
      if (args.method === 'wallet_addEthereumChain') { added = true; return null; }
      if (args.method === 'wallet_switchEthereumChain') {
        if (!added) throw new Error('should not switch on an unauthorised chain first');
        ctl.setChainId(5042002);
        return null;
      }
      return null;
    },
  });
  const result = await run(provider, [1, 137]);
  assert.equal(result.ok, true);
  // No wasted round trip on a request WalletConnect would have dropped.
  assert.equal(provider.calls[0].method, 'wallet_addEthereumChain');
  assert.equal(provider.calls[0].chain, 'eip155:1');
  for (const call of provider.calls) {
    if (call.method !== 'eth_chainId') {
      assert.equal(call.chain, 'eip155:1', `${call.method} must be addressed to an authorised chain`);
    }
  }
});

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
  assert.match(hook, /onArc: isConnected && chainId === arc\.id/);
  assert.match(hook, /const \{ address, chainId, isConnected \} = useAccount\(\)/,
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

/**
 * A WalletConnect session that behaves like the installed stack.
 *
 * Every rule below was read out of the packages this repository actually has, not from general
 * knowledge of WalletConnect, because the whole question is what *these* versions do:
 *
 *   @walletconnect/sign-client 2.23.7 — engine `isValidRequest`:
 *       const { namespaces } = this.client.session.get(topic);
 *       if (!isValidNamespacesChainId(namespaces, chainId))
 *           throw new Error('Missing or invalid. request() chainId: ' + chainId);
 *       if (!isValidNamespacesRequest(namespaces, chainId, request.method))
 *           throw new Error('Missing or invalid. request() method: ' + request.method);
 *     → a request is rejected LOCALLY, before the relay, unless its chain is one the wallet
 *       approved and the method is permitted on it.
 *
 *   @walletconnect/universal-provider 2.23.7 — `UniversalProvider.request(args, chain)`:
 *       const [namespace, ref] = this.validateChain(chain);
 *     → `validateChain` only checks the NAMESPACE ("eip155"), never the chain reference, so it
 *       does not stop an unapproved chain. sign-client is the gate.
 *
 *   @walletconnect/universal-provider — `Eip155Provider.request`:
 *       case 'eth_chainId': return parseInt(this.getDefaultChain());
 *       default: return this.namespace.methods.includes(method)
 *           ? this.client.request(e) : this.getHttpProvider().request(e.request);
 *     → `eth_chainId` NEVER reaches the wallet; it reports the provider's own default chain. A
 *       method outside the approved set is quietly sent to the HTTP RPC instead of the wallet.
 *
 *   @walletconnect/universal-provider — `handleSwitchChain`:
 *       if (isChainApproved(id)) setDefaultChain(id)
 *       else if (methods.includes('wallet_switchEthereumChain')) {
 *           await client.request({ ..., chainId: namespace.chains[0] }); setDefaultChain(id);
 *       } else throw new Error("Failed to switch to chain 'eip155:…'");
 *     → the switch is forwarded on the FIRST APPROVED CHAIN, and `setDefaultChain` is then called
 *       optimistically. It changes the provider's local default only; it does not, and cannot,
 *       add a chain to the session.
 */

export const ARC = 5042002;

const DEFAULT_METHODS = [
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
];

/**
 * @param {object} options
 * @param {number[]} options.approvedChains Chains the wallet approved at session time.
 * @param {string[]} [options.methods] Methods the session permits.
 * @param {boolean} [options.walletKnowsArc] Whether the wallet already has Arc configured.
 * @param {boolean} [options.emitsSessionUpdate] Whether the wallet adds Arc to the session after
 *   `wallet_addEthereumChain` — real wallets differ, which is the entire point of the test.
 * @param {boolean} [options.rejectAdd]
 */
export function createWalletConnectSession({
  approvedChains = [1],
  methods = DEFAULT_METHODS,
  walletKnowsArc = false,
  emitsSessionUpdate = false,
  rejectAdd = false,
} = {}) {
  const walletChains = new Set(approvedChains);
  if (walletKnowsArc) walletChains.add(ARC);

  const session = {
    topic: 'test-topic',
    namespaces: { eip155: { chains: approvedChains.map((id) => `eip155:${id}`), methods, accounts: [] } },
  };

  let defaultChain = approvedChains[0] ?? 1;
  const walletRequests = [];   // what the wallet actually saw
  const allRequests = [];      // everything attempted, rejected or not

  const approvedChainIds = () => session.namespaces.eip155.chains
    .map((c) => Number.parseInt(c.split(':')[1], 10));

  /** sign-client engine `isValidRequest`, verbatim in behaviour. */
  const signClientRequest = ({ chainId, request }) => {
    if (!approvedChainIds().includes(Number.parseInt(chainId.split(':')[1], 10))) {
      throw new Error(`Missing or invalid. request() chainId: ${chainId}`);
    }
    if (!session.namespaces.eip155.methods.includes(request.method)) {
      throw new Error(`Missing or invalid. request() method: ${request.method}`);
    }
    walletRequests.push({ method: request.method, params: request.params, chainId });
    return handleAtWallet(request);
  };

  const handleAtWallet = (request) => {
    switch (request.method) {
      case 'wallet_addEthereumChain': {
        if (rejectAdd) { const e = new Error('User rejected the request'); e.code = 4001; throw e; }
        walletChains.add(Number.parseInt(request.params[0].chainId, 16));
        if (emitsSessionUpdate && !session.namespaces.eip155.chains.includes(`eip155:${ARC}`)) {
          // The only supported way a chain enters an existing session: the wallet updates it.
          session.namespaces.eip155.chains = [...session.namespaces.eip155.chains, `eip155:${ARC}`];
        }
        return null;
      }
      case 'wallet_switchEthereumChain': {
        const target = Number.parseInt(request.params[0].chainId, 16);
        if (!walletChains.has(target)) {
          const e = new Error('Internal JSON-RPC error.');
          e.code = -32603;
          e.data = { originalError: { code: 4902, message: 'Unrecognized chain ID' } };
          throw e;
        }
        return null;
      }
      case 'eth_sendTransaction': return '0x' + 'ab'.repeat(32);
      case 'personal_sign':
      case 'eth_signTypedData_v4': return '0x' + 'cd'.repeat(65);
      default: return null;
    }
  };

  const provider = {
    session,
    get defaultChain() { return defaultChain; },
    /** `UniversalProvider.request(args, chain)` → `Eip155Provider.request`. */
    async request(args, chain) {
      const method = args.method;
      const caip = chain ?? `eip155:${defaultChain}`;
      allRequests.push({ method, params: args.params, chain: chain ?? null });

      // validateChain: namespace only.
      if (!caip.startsWith('eip155:')) {
        throw new Error(`Namespace '${caip.split(':')[0]}' is not configured.`);
      }

      // eth_chainId is answered locally and never reaches the wallet.
      if (method === 'eth_chainId') return `0x${defaultChain.toString(16)}`;

      if (method === 'wallet_switchEthereumChain') {
        const target = Number.parseInt(args.params[0].chainId, 16);
        if (approvedChainIds().includes(target)) { defaultChain = target; return null; }
        if (!session.namespaces.eip155.methods.includes('wallet_switchEthereumChain')) {
          throw new Error(`Failed to switch to chain 'eip155:${target}'. The chain is not approved or the wallet does not support 'wallet_switchEthereumChain' method.`);
        }
        // Forwarded on the first approved chain, then the default is set optimistically.
        const result = signClientRequest({
          chainId: session.namespaces.eip155.chains[0],
          request: { method, params: args.params },
        });
        defaultChain = target;
        return result;
      }

      if (!session.namespaces.eip155.methods.includes(method)) {
        // Falls through to the HTTP RPC, which has no wallet_* methods.
        throw new Error(`the method ${method} does not exist/is not available`);
      }
      return signClientRequest({ chainId: caip, request: { method, params: args.params } });
    },
    on() {}, removeListener() {},
  };

  return {
    provider,
    walletRequests,
    allRequests,
    approvedChainIds,
    sessionChains: () => [...session.namespaces.eip155.chains],
    walletHasArc: () => walletChains.has(ARC),
  };
}

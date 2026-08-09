import { useCallback, useEffect, useState } from 'react';
import { useAccount, useConfig } from 'wagmi';
import { getAccount } from 'wagmi/actions';
import { arc } from './arc.js';
import {
  ARC_CHAIN_ID,
  ARC_SWITCH_STATUS,
  arcAuthorizedForSession,
  ensureArcNetwork,
} from './arc-network-onboarding.js';

/**
 * Which chain the connected wallet is actually on.
 *
 * `useChainId()` cannot answer this. It reads `config.state.chainId`, and Wagmi deliberately
 * refuses to move that value to a chain the config does not list — MemeVerse lists exactly one,
 * so a wallet sitting on Ethereum mainnet still reported 5042002 and every "are we on Arc?" check
 * in the app said yes. The switch-to-Arc control showed ON, and the sign buttons were enabled,
 * for a wallet that was not on Arc at all.
 *
 * `useAccount().chainId` comes from the connection itself and reports the wallet's real chain,
 * unsupported ones included. Every network guard reads it through this hook so there is one
 * answer, and so a transaction can never be offered against an unintended network.
 */
export function useArcNetwork() {
  const { address, chainId, isConnected, connector } = useAccount();
  const sessionAuthorized = useArcSessionAuthorization(connector, chainId);
  /*
    Being on Arc is not the same as being able to transact on Arc. Over WalletConnect,
    sign-client refuses any request whose chain is missing from the session, and the chain the
    provider reports is its own optimistic default rather than anything the wallet said. So the
    guard that enables signing requires both: the wallet is on Arc, and this session may carry an
    Arc request. An injected wallet has no session and is authorised by definition.
  */
  const onChain = isConnected && chainId === arc.id;
  return {
    address,
    isConnected,
    chainId: chainId ?? null,
    sessionAuthorized,
    onArc: onChain && sessionAuthorized,
    // Still "on the wrong network" from the visitor's point of view: the remedy is the same
    // control, and it now knows to ask for a reconnect rather than another switch.
    wrongNetwork: isConnected && !(onChain && sessionAuthorized),
  };
}

/**
 * Whether the live WalletConnect session authorises Arc.
 *
 * Resolved from the connector rather than assumed, and re-resolved whenever the connection or the
 * chain changes. It starts as `true` for the case that dominates — an injected wallet, which has
 * no session — and is corrected to `false` only once a WalletConnect session is found to be
 * missing Arc, so a desktop extension never flickers into a disabled state on mount.
 */
function useArcSessionAuthorization(connector, chainId) {
  const [authorized, setAuthorized] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!connector) { setAuthorized(true); return undefined; }
    (async () => {
      try {
        const provider = await connector.getProvider();
        const chains = provider?.session?.namespaces?.eip155?.chains;
        if (cancelled) return;
        if (!Array.isArray(chains)) { setAuthorized(true); return; }
        setAuthorized(arcAuthorizedForSession(
          chains.map((caip) => Number.parseInt(String(caip).split(':')[1], 10)),
        ));
      } catch {
        // A provider that cannot be read is not evidence of anything; leave the guard as it was
        // rather than disabling a working wallet on a transient failure.
      }
    })();
    return () => { cancelled = true; };
  }, [connector, chainId]);

  return authorized;
}

/**
 * The chains a WalletConnect session actually authorises, or an empty list for a wallet where the
 * question does not arise. This is the difference between a request the wallet sees and a request
 * WalletConnect drops before it leaves the browser.
 */
function sessionChainIdsOf(provider) {
  const chains = provider?.session?.namespaces?.eip155?.chains;
  if (!Array.isArray(chains)) return [];
  return chains
    .map((caip) => Number.parseInt(String(caip).split(':')[1], 10))
    .filter((id) => Number.isInteger(id));
}

/**
 * Switch the connected wallet to Arc, adding the network first if the wallet does not have it.
 *
 * The provider comes from the connector of the *current session*. `window.ethereum` is never
 * consulted: during a WalletConnect session on a phone it is either absent or belongs to an
 * unrelated wallet, and talking to it would send the request to the wrong place — or nowhere.
 */
export function useArcNetworkSwitch() {
  const config = useConfig();
  const { connector } = useAccount();
  const [state, setState] = useState({ status: 'idle', message: null, diagnostic: null });

  const switchToArc = useCallback(async () => {
    const active = connector ?? getAccount(config).connector;
    if (!active) {
      setState({ status: ARC_SWITCH_STATUS.SWITCH_UNSUPPORTED, message: 'CONNECT A WALLET FIRST', diagnostic: null });
      return false;
    }
    setState({ status: 'pending', message: null, diagnostic: null });
    try {
      const provider = await active.getProvider();
      if (!provider?.request) throw new Error('The connected wallet exposes no request method.');

      const result = await ensureArcNetwork({
        connectorId: active.id,
        sessionChainIds: sessionChainIdsOf(provider),
        request: (args, chain) => (chain ? provider.request(args, chain) : provider.request(args)),
        readSessionChainIds: async () => sessionChainIdsOf(await active.getProvider()),
        readChainId: async () => {
          const hex = await provider.request({ method: 'eth_chainId' });
          const parsed = Number.parseInt(String(hex), 16);
          // A WalletConnect provider answers `eth_chainId` from its own session default, which can
          // lag the wallet by a beat. Wagmi's connection state is the second opinion, and either
          // one reporting Arc is enough — both derive from the wallet, not from this page.
          if (parsed === ARC_CHAIN_ID) return parsed;
          const fromWagmi = getAccount(config).chainId;
          return fromWagmi === ARC_CHAIN_ID ? fromWagmi : parsed;
        },
      });

      setState({
        status: result.status,
        message: result.message,
        diagnostic: result.diagnostic,
      });
      return result.ok;
    } catch (error) {
      setState({
        status: ARC_SWITCH_STATUS.SWITCH_UNSUPPORTED,
        message: 'WALLET DOES NOT SUPPORT ARC NETWORK SWITCHING',
        diagnostic: { shortMessage: (error?.shortMessage ?? error?.message ?? 'unknown').slice(0, 160) },
      });
      return false;
    }
  }, [config, connector]);

  return {
    switchToArc,
    status: state.status,
    isPending: state.status === 'pending',
    failed: !['idle', 'pending', ARC_SWITCH_STATUS.ON_ARC].includes(state.status),
    message: state.message,
    diagnostic: state.diagnostic,
  };
}

/**
 * Reown AppKit — the WalletConnect-ecosystem wallet modal — wired to MemeVerse's existing Wagmi
 * architecture.
 *
 * NOT Circle App Kit. MemeVerse's Circle App Kit / Stablecoin Kits integration is server-side and
 * is untouched by this file; the `reown` prefixes exist so the two are never confused.
 *
 * Everything below runs at module scope, on purpose. AppKit registers its web components and its
 * connectors as a side effect of construction, and Wagmi needs the resulting config before the
 * first render — so this must not be built inside a component, a `useEffect`, or any other
 * lifecycle hook.
 *
 * The Wagmi config exported here is the adapter's own `wagmiConfig`. Every existing hook —
 * `useAccount`, `useChainId`, `useSwitchChain`, `useSignMessage`, `useWriteContract` — keeps
 * working against it unchanged. WalletConnect is transport and session UX only; it changes
 * nothing about how a MemeVerse transaction is built, signed, or confirmed.
 */
import { fallback } from 'viem';
import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { createAppKit } from '@reown/appkit/react';
import { ARC_FALLBACK_RPC_URL, ARC_RPC_URL, arc } from './arc.js';
import {
  reownAppKitConfigured,
  reownAppKitFeatures,
  reownAppKitMetadata,
  reownAppKitTheme,
  reownArcNetwork,
  reownCustomRpcUrls,
  reownProjectId,
} from './wallet-connection.js';

/**
 * MemeVerse's existing Arc transport, unchanged: primary endpoint first, documented fallback
 * behind it. Arc Testnet is not one of the chains Reown's Blockchain API serves, so the adapter
 * passes this through untouched rather than substituting an RPC of its own.
 */
const arcTransports = { [arc.id]: fallback([http(ARC_RPC_URL), http(ARC_FALLBACK_RPC_URL)]) };

/**
 * Built only when a Reown project id is configured. Without one there is no relay to pair over,
 * and `createAppKit` would ship a modal that cannot connect anything — so the app falls back to
 * the injected-only configuration it had before, which still serves desktop extension wallets,
 * and the header says plainly that WalletConnect is unconfigured.
 */
export const wagmiAdapter = reownAppKitConfigured
  ? new WagmiAdapter({
    networks: [reownArcNetwork],
    projectId: reownProjectId,
    customRpcUrls: reownCustomRpcUrls,
    transports: arcTransports,
  })
  : null;

export const reownAppKit = wagmiAdapter
  ? createAppKit({
    adapters: [wagmiAdapter],
    networks: [reownArcNetwork],
    defaultNetwork: reownArcNetwork,
    projectId: reownProjectId,
    metadata: reownAppKitMetadata,
    customRpcUrls: reownCustomRpcUrls,
    features: reownAppKitFeatures,
    ...reownAppKitTheme,
    // The whole WalletConnect catalog, not a hand-picked shortlist. Arc is an ordinary EVM chain
    // and any EVM wallet its user already owns should be offered.
    allWallets: 'SHOW',
    enableWalletConnect: true,
    enableInjected: true,
    enableEIP6963: true,
    /**
     * Coinbase Wallet stays enabled, and reaches MemeVerse two ways: as an EIP-6963 browser
     * extension, and from the WalletConnect catalogue on mobile.
     *
     * Its third path — the Coinbase / Base Account popup SDK — bootstraps by injecting an inline
     * <script>, which MemeVerse's `script-src 'self'` refuses. AppKit handles that by not adding
     * the connector at all, so the modal shows no dead entry; the trade is deliberate, because
     * the alternative is `unsafe-inline`, and a policy that permits one injected script permits
     * every injected script. `coinbasePreference: 'eoaOnly'` was tried and does not avoid the
     * injection.
     */
    enableCoinbase: true,
    /**
     * A wallet sitting on the wrong chain stays connected and MemeVerse's own "BUILT ON ARC"
     * control asks for the switch, rather than AppKit taking over with a modal of its own. This
     * is safe because every write path in the app is gated on `isConnected && chainId === arc.id`,
     * so a transaction cannot be sent from an unintended network either way.
     */
    allowUnsupportedChain: true,
  })
  : null;

/** True when the wallet modal can actually be opened — i.e. a Reown project id was configured. */
export const walletModalAvailable = Boolean(reownAppKit);

export const wagmiConfig = wagmiAdapter
  ? wagmiAdapter.wagmiConfig
  : createConfig({
    chains: [arc],
    connectors: [injected()],
    transports: arcTransports,
  });

/**
 * Opens the modal on a named view within the EVM namespace.
 *
 * `Connect` when there is no wallet yet; `Account` when there is one, so that an accidental tap
 * on the header shows the account and its controls instead of silently dropping the session.
 * Returns false when no modal exists, which lets the caller fall back rather than swallow a tap.
 */
export function openWalletModal(view = 'Connect') {
  if (!reownAppKit) return false;
  Promise.resolve(reownAppKit.open({ view, namespace: 'eip155' })).catch((error) => {
    console.error('[MemeVerse] Reown AppKit failed to open', error);
  });
  return true;
}

/**
 * Wallet connection configuration, expressed as plain values.
 *
 * This module deliberately imports nothing from Reown AppKit. Everything here is data or a pure
 * function, so the properties that decide whether a visitor can connect — the chain that will be
 * offered, the origin the wallet is told it is approving, which AppKit product surfaces are on —
 * can be asserted in a Node test without a bundler, a browser, or a WalletConnect relay.
 *
 * `src/reown-appkit.js` is the module that actually constructs the AppKit instance from these
 * values, and it is the only file that may import `@reown/appkit`.
 *
 * NOTE ON NAMING: "Reown AppKit" here is the WalletConnect-ecosystem wallet modal. It is not
 * Circle App Kit / Stablecoin Kits, which MemeVerse uses server-side and which this file does not
 * touch. Every identifier below is prefixed `reown` so the two can never be misread for each
 * other.
 */
import { mainnet } from 'viem/chains';
import { ARC_READ_FALLBACK_RPC_URL, ARC_READ_RPC_URL, arc } from './arc.js';

// `import.meta.env` only exists under Vite, exactly as in src/arc.js. Defaulting it keeps this
// module importable from plain Node so the configuration can be unit tested.
const viteEnv = import.meta.env ?? {};

/**
 * The single Arc chain id MemeVerse operates on. Declared as a literal so a test can catch a
 * chain definition drifting underneath the wallet layer rather than discovering it when a
 * transaction is signed against the wrong network.
 */
export const ARC_TESTNET_CHAIN_ID = 5042002;

/**
 * The Reown network is the existing Arc definition, not a second copy of it. Reown's adapter
 * extends whatever it is handed into a CAIP network on its own (adding `caipNetworkId`,
 * `chainNamespace`, and image metadata) and does so on a copy, so passing the project's own
 * `arc` object keeps one source of truth for the RPC URLs, the explorer, and the currency.
 */
export const reownArcNetwork = arc;

/**
 * Networks the installed Reown/Wagmi adapter must be able to represent while establishing a
 * WalletConnect session.
 *
 * MemeVerse is still an Arc-only product. Ethereum is present solely because a real mobile wallet
 * that does not know Arc yet commonly returns an otherwise-valid session on `eip155:1`. AppKit
 * 1.8.23 then asks Wagmi to synchronise that returned chain before MemeVerse can run its own Arc
 * onboarding flow. If chain 1 is absent, Reown's WalletConnectConnector throws
 * `ChainNotConfiguredError` before any request reaches the wallet.
 *
 * AppKit's network switcher is disabled, Arc remains the default, and every MemeVerse write stays
 * gated by `useArcNetwork().onArc`, so this auxiliary entry cannot expose or enable product writes
 * on Ethereum.
 */
export const reownSessionNetworks = Object.freeze([reownArcNetwork, mainnet]);

/**
 * Reown resolves its own RPC for the networks its Blockchain API supports. Arc Testnet is not one
 * of them, so nothing is substituted — but the URLs are still declared explicitly, and handed to
 * both the adapter and `createAppKit`, so the modal and the transport agree on which Arc endpoints
 * MemeVerse uses instead of leaving it to a default.
 */
export const reownArcCaipNetworkId = `eip155:${ARC_TESTNET_CHAIN_ID}`;
export const reownCustomRpcUrls = Object.freeze({
  [reownArcCaipNetworkId]: Object.freeze([
    Object.freeze({ url: ARC_READ_RPC_URL }),
    Object.freeze({ url: ARC_READ_FALLBACK_RPC_URL }),
  ]),
});

/**
 * The origin a wallet displays to the person approving the connection. It must be the real
 * MemeVerse origin and must match the allowed origin configured for the project on
 * dashboard.reown.com, or wallets will show a mismatched-origin warning.
 */
export const MEMEVERSE_ORIGIN = 'https://memeverse.biz';

// Mirrors the committed default in vite.config.js. In the browser `BASE_URL` is always the base
// the bundle was actually built with; the fallback only applies when this module is imported
// outside Vite, and it names the same path the project deploys to.
const basePath = viteEnv.BASE_URL ?? '/memeverse/';

export const reownAppKitMetadata = Object.freeze({
  name: 'MemeVerse',
  description: 'A meme becomes an economy on Arc.',
  url: MEMEVERSE_ORIGIN,
  icons: Object.freeze([new URL(`${basePath}memeverse-mark.png`, MEMEVERSE_ORIGIN).toString()]),
});

/**
 * The Reown Cloud project id. Absent by design from the repository: it is per-deployment
 * configuration, not a secret to invent. Without it there is no WalletConnect relay, so
 * `src/reown-appkit.js` degrades to an injected-only configuration rather than shipping a modal
 * that cannot pair.
 */
export const reownProjectId = (viteEnv.VITE_REOWN_PROJECT_ID ?? '').trim();
export const reownAppKitConfigured = reownProjectId.length > 0;

/**
 * AppKit is used here as a wallet connector and nothing else. Email and social login are not
 * MemeVerse authentication methods, and swaps and onramp are not MemeVerse products — a visitor
 * who opens this modal is trying to attach a wallet, so nothing else belongs in it.
 *
 * IMPORTANT: since AppKit 1.7 these four are *remote* features. When a project configuration is
 * fetched successfully from Reown Cloud, the dashboard's values win and the flags below are
 * ignored (AppKit logs a warning saying so). They are still declared, because they are the
 * fallback whenever that fetch fails and because they state the intended configuration in code —
 * but email, socials, swaps, and onramp must ALSO be disabled on dashboard.reown.com for the
 * project. See README "Wallet connection (Reown AppKit)".
 */
export const reownAppKitFeatures = Object.freeze({
  email: false,
  emailShowWallets: false,
  socials: false,
  swaps: false,
  onramp: false,
  history: false,
  send: false,
  receive: false,
  // Analytics stays off; AppKit still reports two mandatory lifecycle events, which is why the
  // Content Security Policy allows pulse.walletconnect.org.
  analytics: false,
  allWallets: true,
});

/**
 * Restrained MemeVerse styling through AppKit's supported theme variables. The modal's internals
 * are a shadow DOM and are not selected against: anything not expressible here is left alone.
 */
export const reownAppKitTheme = Object.freeze({
  themeMode: 'dark',
  themeVariables: Object.freeze({
    '--w3m-accent': '#C6F432',
    '--w3m-color-mix': '#0B0B0D',
    '--w3m-color-mix-strength': 24,
    '--w3m-border-radius-master': '1px',
    '--w3m-font-family': "'Space Mono', ui-monospace, monospace",
    '--w3m-font-size-master': '10px',
    '--w3m-z-index': 30,
  }),
});

/** Truncates an address for display: `0x1234…abcd`. Returns null for anything unusable. */
export function shortWalletAddress(address) {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The label on MemeVerse's own header button.
 *
 * The disconnected label is unconditional. It used to depend on whether an injected provider had
 * answered, which is why an ordinary mobile browser — where there is no injected provider and
 * never will be — was told the wallet was unavailable instead of being offered WalletConnect.
 * There is now always something to open, so the button always says so.
 */
export function walletButtonLabel({
  isConnected = false,
  isConnecting = false,
  address = null,
  balanceLabel = null,
} = {}) {
  const short = shortWalletAddress(address);
  if (isConnected && short) {
    return balanceLabel ? `${balanceLabel} // ${short}` : short;
  }
  if (isConnecting) return 'CONNECTING…';
  return 'CONNECT WALLET';
}

/**
 * Embedded in-app browsers that block navigation to a wallet's URL scheme at the OS or WebView
 * level. No amount of application JavaScript can open a wallet app from inside one of these, so
 * the only honest response is to say which browser to use instead.
 *
 * These patterns are deliberately narrow. A false positive nags an ordinary Safari or Chrome user
 * about a problem they do not have, which is worse than missing a case: on iOS in particular a
 * `WKWebView` reports a user agent all but identical to Safari's, so most iOS in-app browsers are
 * simply not detectable here and are not guessed at.
 */
const RESTRICTED_EMBEDDED_BROWSERS = Object.freeze([
  /;\s*wv[;)]/i, // Android System WebView — Discord, Telegram, Slack, and most Android in-app browsers
  /\bFBAN\/|\bFBAV\/|FB_IAB\//i, // Facebook / Messenger
  /\bInstagram\b/i,
  /\bLine\/[\d.]+\/IAB/i,
  /\bTelegramWebView\b/i,
]);

export function isRestrictedEmbeddedBrowser(userAgent) {
  if (typeof userAgent !== 'string' || userAgent.length === 0) return false;
  return RESTRICTED_EMBEDDED_BROWSERS.some((pattern) => pattern.test(userAgent));
}

export const RESTRICTED_BROWSER_HINT = 'OPEN MEMEVERSE IN SAFARI / CHROME OR YOUR WALLET BROWSER';

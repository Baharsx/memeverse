/**
 * Content Security Policy shared by the Express API and the production Vite build.
 *
 * The browser bundle is served as static assets, so the built `index.html` carries the same
 * policy through a `<meta http-equiv>` tag. Development keeps Vite's own relaxed behaviour
 * because the dev server needs inline module preambles and an eval-based HMR client.
 */
// Every Arc endpoint the browser may legitimately reach. The first two are the application read
// transport and are what the page actually uses; the `.arc.network` pair stays allowed because
// `VITE_ARC_RPC_URL` is environment-overridable and because a deployment may prefer them. All four
// were verified to answer `eth_chainId` with `0x4cef52`. An allowlist entry permits a request; it
// does not choose one — which endpoint is read is decided in src/arc.js, and only the read pair
// survives a Markets-page burst (see `npm run rpc:burst:check`).
const ARC_RPC_ORIGINS = Object.freeze([
  'https://rpc.testnet.arc.io',
  'https://rpc.drpc.testnet.arc.io',
  'https://rpc.testnet.arc.network',
  'https://rpc.quicknode.testnet.arc.network',
]);

// src/styles.css imports the Clash Display, Geist, and Space Mono web fonts. These are the
// exact stylesheet and font-file hosts those imports use; nothing wider is permitted.
const FONT_STYLESHEET_ORIGINS = Object.freeze([
  'https://api.fontshare.com',
  'https://fonts.googleapis.com',
]);
const FONT_FILE_ORIGINS = Object.freeze([
  'https://cdn.fontshare.com',
  'https://fonts.gstatic.com',
  // Reown AppKit's modal declares @font-face rules for its own typeface. MemeVerse overrides the
  // family through AppKit's theme variables, but the declarations are injected regardless and the
  // browser reports a policy violation for each one unless the host is named.
  'https://fonts.reown.com',
]);

/**
 * Reown AppKit — the wallet modal — reaches exactly these hosts. Nothing here is Circle: Circle
 * App Kit and the Circle wallets are server-side and never contacted from the browser.
 *
 * - api.web3modal.org: the project configuration and the WalletConnect wallet catalogue.
 * - relay.walletconnect.org: the WalletConnect v2 relay. This is the socket a mobile wallet pairs
 *   over, so without it the entire mobile connection path fails.
 * - rpc.walletconnect.org: Reown's Blockchain API, used for identity lookups. It is deliberately
 *   NOT an Arc RPC — Arc is not a chain that API serves, so MemeVerse's own Arc endpoints above
 *   remain the only place a MemeVerse transaction is ever sent.
 * - pulse.walletconnect.org: AppKit analytics are disabled, but two lifecycle events are sent
 *   unconditionally by the SDK. Naming the host keeps that from surfacing as a policy violation.
 */
const REOWN_APPKIT_ORIGINS = Object.freeze([
  'https://api.web3modal.org',
  'https://rpc.walletconnect.org',
  'https://pulse.walletconnect.org',
  'https://relay.walletconnect.org',
  'wss://relay.walletconnect.org',
]);

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function contentSecurityPolicyDirectives({ connectSources = [] } = {}) {
  const connect = ["'self'", ...new Set(
    [...ARC_RPC_ORIGINS, ...REOWN_APPKIT_ORIGINS, ...connectSources].map(originOf).filter(Boolean),
  )];
  return {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'frame-src': ["'none'"],
    'script-src': ["'self'"],
    // Injected-provider and animation libraries write style attributes at runtime; no inline
    // <script> is permitted, so this does not enable script execution.
    'style-src': ["'self'", "'unsafe-inline'", ...FONT_STYLESHEET_ORIGINS],
    // Media NFT artwork is minted by users and lives on hosts MemeVerse does not control, so an
    // origin allowlist cannot express the gallery. `https:` is the narrowest expression that still
    // renders a real collection: it is scheme-restricted rather than a wildcard, images cannot
    // execute script, and `referrerPolicy: no-referrer` keeps the visited URL from leaking to the
    // image host. The browser additionally refuses to render any media URL that is not https or a
    // data: image, so a hostile `javascript:` token URI is dropped before this point.
    //
    // `blob:` covers one narrow case: the local preview of a file the visitor has just chosen from
    // their own disk, before anything is signed or uploaded. A blob URL can only be minted by this
    // page's own script and only ever refers to memory this document already holds, so it grants
    // no reach that the page did not already have. It is emphatically not a channel for untrusted
    // metadata — `safeMediaUrl()` still refuses a `blob:` token URI outright, so a minter cannot
    // use this to point the gallery at anything.
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", ...FONT_FILE_ORIGINS],
    'connect-src': connect,
    'form-action': ["'self'"],
    'manifest-src': ["'self'"],
    'worker-src': ["'self'"],
  };
}

export function serializeContentSecurityPolicy(directives) {
  return Object.entries(directives)
    .map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

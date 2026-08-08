/**
 * Content Security Policy shared by the Express API and the production Vite build.
 *
 * The browser bundle is served as static assets, so the built `index.html` carries the same
 * policy through a `<meta http-equiv>` tag. Development keeps Vite's own relaxed behaviour
 * because the dev server needs inline module preambles and an eval-based HMR client.
 */
const ARC_RPC_ORIGINS = Object.freeze([
  'https://rpc.testnet.arc.io',
  'https://rpc.drpc.testnet.arc.io',
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
    [...ARC_RPC_ORIGINS, ...connectSources].map(originOf).filter(Boolean),
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

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {
  contentSecurityPolicyDirectives,
  serializeContentSecurityPolicy,
} from './server/security/csp.js';

/**
 * The browser bundle is served as static assets, so its Content Security Policy travels in the
 * built document. Development is excluded because the Vite dev server needs an inline module
 * preamble and an eval-based HMR client; the production build has neither.
 */
function contentSecurityPolicyMeta(apiBaseUrl) {
  const directives = contentSecurityPolicyDirectives({
    connectSources: apiBaseUrl ? [apiBaseUrl] : [],
  });
  // `frame-ancestors` is defined to be ignored when delivered in a meta element, so shipping it
  // here buys nothing and logs a console warning on every page load. The static document is served
  // by the reverse proxy, not by the API, so it gets its clickjacking protection over HTTP from
  // that proxy — `Content-Security-Policy: frame-ancestors 'none'` plus `X-Frame-Options: DENY`,
  // both documented in the README's nginx example. The rest of the policy travels in this tag.
  const { 'frame-ancestors': _ignoredInMeta, ...deliverable } = directives;
  const policy = serializeContentSecurityPolicy(deliverable);
  return {
    name: 'memeverse-csp-meta',
    apply: 'build',
    transformIndexHtml() {
      return [{
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
        injectTo: 'head-prepend',
      }];
    },
  };
}

export default defineConfig({
  /**
   * The committed default serves MemeVerse from a `/memeverse/` sub-path, which is what the
   * project has always deployed to. A root-domain deployment sets `VITE_BASE_PATH=/`; the router
   * derives its basename from the same value, so the two can never disagree.
   */
  base: process.env.VITE_BASE_PATH?.trim() || '/memeverse/',
  plugins: [react(), contentSecurityPolicyMeta(process.env.VITE_API_BASE_URL)],
  build: {
    rollupOptions: {
      output: {
        /**
         * Chunking is left to Rollup, with one exception below.
         *
         * This used to be a substring-matched map of the wallet and chain libraries into fixed
         * `wallet` / `chain` / `vendor` buckets. Reown AppKit cannot survive that: its packages
         * import each other cyclically, and a hand-drawn boundary through a cycle produces chunks
         * that evaluate in the wrong order — the built site died on load with "Cannot access 'E_'
         * before initialization", which no test that stops at `vite build` would have caught.
         * Rollup's own chunking respects those cycles, and it also preserves the dynamic-import
         * boundaries AppKit already has, so the modal, the on-ramp, the swap, and the social
         * surfaces stay in chunks that are never fetched by a visitor who does not open them.
         *
         * React is the exception: it is a leaf as far as the wallet stack is concerned, it cannot
         * take part in one of those cycles, and it is the largest dependency that genuinely never
         * changes between deploys — so it stays separately cacheable. The path is matched exactly
         * rather than by substring, which is what previously swept unrelated packages in.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  // `vite preview` is how the production bundle is smoke-tested locally, and the operator session
  // cookie is SameSite=Strict — so the preview server has to present the API on its own origin
  // exactly as the real reverse proxy does, or the rehearsal tests a different application.
  preview: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});

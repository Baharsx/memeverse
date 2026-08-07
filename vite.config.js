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
         * The wallet and chain libraries dominate the bundle and change far less often than
         * MemeVerse's own code. Splitting them out keeps the application chunk small and lets a
         * returning visitor reuse the cached vendor chunks across deploys.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('wagmi') || id.includes('@tanstack')) return 'wallet';
          if (id.includes('viem') || id.includes('ox') || id.includes('@noble')
            || id.includes('@scure') || id.includes('abitype')) return 'chain';
          if (id.includes('react') || id.includes('scheduler')) return 'react';
          if (id.includes('framer-motion') || id.includes('motion')) return 'motion';
          return 'vendor';
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

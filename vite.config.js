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
  const policy = serializeContentSecurityPolicy(
    contentSecurityPolicyDirectives({ connectSources: apiBaseUrl ? [apiBaseUrl] : [] }),
  );
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
  base: '/memeverse/',
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
});

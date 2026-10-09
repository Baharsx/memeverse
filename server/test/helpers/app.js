import { createApp } from '../../app.js';
import { testAppOrigin } from './operator.js';

/** Every route class is unbounded unless a test is specifically exercising a limit. */
export const unlimitedRateLimits = Object.freeze({
  global: 10_000,
  mediaUpload: 10_000,
});

export function baseTestConfig(overrides = {}) {
  return {
    nodeEnv: 'test',
    appOrigin: testAppOrigin,
    arcChainId: 5042002,
    trustedProxyHopCount: 0,
    secureCookies: false,
    rateLimits: unlimitedRateLimits,
    ...overrides,
  };
}

export const verifiedArcRpc = {
  async health() {
    return {
      status: 'verified',
      chainId: 5042002,
      blockNumber: 1234,
      checkedAt: new Date().toISOString(),
    };
  },
};

export async function startTestApp({
  configOverrides = {},
  mediaService,
} = {}) {
  const config = baseTestConfig(configOverrides);
  const app = createApp({
    config,
    arcRpc: verifiedArcRpc,
    mediaService,
    logger: { info() {}, error() {} },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    server,
    mediaService,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

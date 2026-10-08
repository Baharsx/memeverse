/**
 * Browser boot check for Arc mainnet.
 *
 * Runs only when the built network is mainnet. A read RPC that answers with any chain id other
 * than 5042 aborts immediately. If both the primary and the fallback fail to answer, boot aborts
 * too. Testnet builds skip the check so Node unit tests never call fetch from this module.
 */
import {
  ARC_CHAIN_ID,
  ARC_IS_MAINNET,
  ARC_READ_FALLBACK_RPC_URL,
  ARC_READ_RPC_URL,
} from './arc.js';

export async function assertBrowserReadChain({
  enabled = ARC_IS_MAINNET,
  expectedChainId = ARC_CHAIN_ID,
  urls = [ARC_READ_RPC_URL, ARC_READ_FALLBACK_RPC_URL],
  fetchImplementation = globalThis.fetch,
} = {}) {
  if (!enabled) return null;
  let lastError = null;
  for (const url of urls) {
    try {
      const response = await fetchImplementation(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const chainId = Number.parseInt(payload.result, 16);
      if (!Number.isInteger(chainId)) {
        throw new Error(`Read RPC ${url} did not return eth_chainId.`);
      }
      if (chainId !== expectedChainId) {
        throw new Error(
          `Read RPC ${url} reported chain ${chainId}, expected ${expectedChainId}. Refusing to boot.`,
        );
      }
      return chainId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('reported chain')) throw error;
      lastError = error;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : 'no response';
  throw new Error(`Arc mainnet read RPC chain check failed: ${reason}`);
}

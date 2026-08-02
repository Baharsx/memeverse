import { DomainError } from '../domain/errors.js';

export class ArcRpcClient {
  constructor({ rpcUrl, expectedChainId, fetchImplementation = fetch, timeoutMs = 5000 }) {
    this.rpcUrl = rpcUrl;
    this.expectedChainId = expectedChainId;
    this.fetchImplementation = fetchImplementation;
    this.timeoutMs = timeoutMs;
  }

  async call(method, id) {
    const response = await this.fetchImplementation(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: [] }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Arc RPC returned HTTP ${response.status}.`);

    const payload = await response.json();
    if (payload.error || typeof payload.result !== 'string') {
      throw new Error(payload.error?.message ?? `Arc RPC did not return ${method}.`);
    }
    return payload.result;
  }

  async health() {
    const checkedAt = new Date().toISOString();
    try {
      const [chainHex, blockHex] = await Promise.all([
        this.call('eth_chainId', 1),
        this.call('eth_blockNumber', 2),
      ]);
      const chainId = Number.parseInt(chainHex, 16);
      const blockNumber = Number.parseInt(blockHex, 16);
      if (chainId !== this.expectedChainId) {
        throw new DomainError(
          'ARC_CHAIN_MISMATCH',
          `Expected Arc chain ${this.expectedChainId}, received ${chainId}.`,
          { status: 503 },
        );
      }
      return { status: 'verified', chainId, blockNumber, checkedAt };
    } catch (error) {
      return {
        status: 'degraded',
        chainId: this.expectedChainId,
        checkedAt,
        reason: error instanceof Error ? error.message : 'Arc RPC check failed.',
      };
    }
  }
}

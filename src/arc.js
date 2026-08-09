import { arcTestnet as viemArcTestnet } from 'viem/chains';

// `import.meta.env` only exists under Vite. Defaulting it keeps this module importable from plain
// Node, so the Arc constants and the helpers built on them can be unit tested without a bundler.
const viteEnv = import.meta.env ?? {};

/**
 * The canonical Arc Testnet endpoints, as published in the official chain definition that ships
 * with viem (`viem/chains` → `arcTestnet`) and used by the wider wallet ecosystem.
 *
 * These replace the `rpc.testnet.arc.io` / `rpc.drpc.testnet.arc.io` pair this file used to
 * override them with. Both of those still answer, and both still return chain `0x4cef52`, so
 * neither was broken — but neither appears in the canonical chain definition either, and this
 * value is no longer only an application transport: it is now the RPC URL a wallet is asked to
 * register for Arc through EIP-3085, and what a wallet stores should be the official endpoint.
 *
 * Both hosts below were verified to answer `eth_chainId` with `0x4cef52`, to answer
 * `eth_blockNumber`, and to send `Access-Control-Allow-Origin: https://memeverse.biz`, so the
 * browser can read through them exactly as before.
 */
export const ARC_RPC_URL =
  viteEnv.VITE_ARC_RPC_URL?.trim() || 'https://rpc.testnet.arc.network';
export const ARC_FALLBACK_RPC_URL =
  viteEnv.VITE_ARC_FALLBACK_RPC_URL?.trim() || 'https://rpc.quicknode.testnet.arc.network';

/**
 * 5042002 as EIP-155 hex. Stated once, proven by test against the decimal id, because a wallet
 * network registration is written in hex and one wrong nibble registers a different chain
 * entirely — `0x4CF4B2`, which appears in some stale material, is 5043378, not Arc.
 */
export const ARC_CHAIN_ID = viemArcTestnet.id;
export const ARC_CHAIN_ID_HEX = '0x4cef52';

export const arc = {
  ...viemArcTestnet,
  rpcUrls: {
    default: {
      http: [ARC_RPC_URL, ARC_FALLBACK_RPC_URL],
      webSocket: ['wss://rpc.testnet.arc.network'],
    },
    public: {
      http: [ARC_FALLBACK_RPC_URL],
      webSocket: ['wss://rpc.quicknode.testnet.arc.network'],
    },
  },
  blockExplorers: {
    default: {
      name: 'ArcScan',
      url: 'https://testnet.arcscan.app',
      apiUrl: 'https://testnet.arcscan.app/api',
    },
  },
};

export const arcLinks = Object.freeze({
  docs: 'https://docs.arc.io/',
  status: 'https://status.arc.io/',
  faucet: 'https://faucet.circle.com/',
  explorer: arc.blockExplorers.default.url,
  contracts: 'https://docs.arc.io/arc/references/contract-addresses',
  memos: 'https://docs.arc.io/arc/concepts/transaction-memos',
  batches: 'https://docs.arc.io/arc/concepts/batched-transactions',
  security: 'https://docs.arc.io/arc/concepts/post-quantum-security',
  brand: 'https://www.arc.io/brand-guidelines-and-partner-toolkit',
});

export const arcContracts = Object.freeze({
  usdc: '0x3600000000000000000000000000000000000000',
  memo: '0x5294E9927c3306DcBaDb03fe70b92e01cCede505',
  multicall3From: '0x522fAf9A91c41c443c66765030741e4AaCe147D0',
  memeVerseSettlement: '0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7',
  memeVerseFactory: '0x363124490E953EEbB414eB4c3e2f03a40eef8F2C',
});

export const memoAbi = [
  {
    type: 'function',
    name: 'memo',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'memoId', type: 'bytes32' },
      { name: 'memoData', type: 'bytes' },
    ],
    outputs: [],
  },
];

export const arcCapabilities = Object.freeze({
  phase: 'FINAL MVP / PUBLIC TESTNET',
  realAssets: 'ARC TESTNET USDC + MEME TOKENS',
  confirmationsRequired: 1,
  // Memo CallFrom preserves only a directly signing EOA as msg.sender, so it routes the manual
  // Developer-Controlled Wallet path alone. The Agent Wallet is an ERC-4337 smart account and
  // calls its own settlement contract directly instead.
  transactionMemos: 'MANUAL SETTLEMENT ROUTE / EOA ONLY',
  batchedTransactions: 'TESTNET READY / EOA ONLY',
  postQuantum: 'ROADMAP / NOT YET AVAILABLE',
  appKit: 'SWAP ESTIMATE LIVE / SERVER-ONLY',
  // Two isolated routes: the Agent Wallet executes with no per-payout human approval, and the
  // manual operator route still requires a wallet-signed session plus a settlement-bound approval.
  agentExecution: 'AUTONOMOUS AGENT WALLET + MANUAL OPERATOR ROUTES',
});

import { arcTestnet as viemArcTestnet } from 'viem/chains';

// `import.meta.env` only exists under Vite. Defaulting it keeps this module importable from plain
// Node, so the Arc constants and the helpers built on them can be unit tested without a bundler.
const viteEnv = import.meta.env ?? {};

/**
 * Arc Testnet is reached through two different sets of endpoints, for two unrelated reasons.
 * Conflating them is what broke the Markets page in production, so they are named apart here and
 * a test keeps them apart.
 *
 * 1. THE APPLICATION READ TRANSPORT — every browser read: the Markets list, balances, quotes,
 *    allowances, receipts. One Markets page load fans out to roughly ninety concurrent calls, so
 *    what matters for these hosts is behaviour under *concurrency*, not whether a single
 *    `eth_chainId` succeeds.
 *
 * 2. THE WALLET REGISTRATION ENDPOINT — a single URL, handed to a wallet through EIP-3085 when it
 *    is asked to add Arc, and thereafter used by the wallet, not by this page. What matters for it
 *    is that it is the canonical published endpoint.
 *
 * A previous release pointed both at the canonical `.arc.network` pair. Measured against a burst
 * matching one Markets page load: `rpc.quicknode.testnet.arc.network` answered 90 of 95 calls with
 * HTTP 429, and `rpc.testnet.arc.network` throttled under sustained browser load — so the fallback
 * had nowhere to spill and the Markets page died with ARC RPC READ FAILED. The same burst against
 * `rpc.testnet.arc.io` and `rpc.drpc.testnet.arc.io` returned 95/95. Those two therefore remain the
 * read transport; `npm run rpc:burst:check` is the check that would have caught it.
 */
export const ARC_READ_RPC_URL =
  viteEnv.VITE_ARC_RPC_URL?.trim() || 'https://rpc.testnet.arc.io';
export const ARC_READ_FALLBACK_RPC_URL =
  viteEnv.VITE_ARC_FALLBACK_RPC_URL?.trim() || 'https://rpc.drpc.testnet.arc.io';

/**
 * The one endpoint a wallet is asked to store for Arc. Canonical, from the published chain
 * definition, and deliberately NOT the application's read transport: a wallet keeps this for its
 * own use, so it should be the official host rather than whichever endpoint this page happens to
 * read through. Nothing in the browser fetches it.
 *
 * One URL, not a list. EIP-3085 accepts several, but the second canonical host rate-limits hard
 * enough that offering it would only give a wallet a way to fail.
 */
export const ARC_WALLET_RPC_URL =
  viteEnv.VITE_ARC_WALLET_RPC_URL?.trim() || 'https://rpc.testnet.arc.network';

/**
 * 5042002 as EIP-155 hex. Stated once, proven by test against the decimal id, because a wallet
 * network registration is written in hex and one wrong nibble registers a different chain
 * entirely — `0x4CF4B2`, which appears in some stale material, is 5043378, not Arc.
 */
export const ARC_CHAIN_ID = viemArcTestnet.id;
export const ARC_CHAIN_ID_HEX = '0x4cef52';

/**
 * The chain as MemeVerse READS it. `rpcUrls` here is the application transport and nothing else —
 * the wallet-registration payload is built from `ARC_WALLET_RPC_URL` and never from this object,
 * which is the coupling that caused the rollback.
 */
export const arc = {
  ...viemArcTestnet,
  rpcUrls: {
    default: {
      http: [ARC_READ_RPC_URL, ARC_READ_FALLBACK_RPC_URL],
      webSocket: ['wss://rpc.testnet.arc.io'],
    },
    public: {
      http: [ARC_READ_FALLBACK_RPC_URL],
      webSocket: ['wss://rpc.drpc.testnet.arc.io'],
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

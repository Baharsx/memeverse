import { arc as viemArcMainnet, arcTestnet as viemArcTestnet } from 'viem/chains';
import { ARC_MULTICALL3_ADDRESS, ARC_NETWORKS, resolveArcNetwork } from './arc-networks.js';

// `import.meta.env` only exists under Vite. Defaulting it keeps this module importable from plain
// Node, so the Arc constants and the helpers built on them can be unit tested without a bundler.
const viteEnv = import.meta.env ?? {};

export const ARC_NETWORK = resolveArcNetwork({
  VITE_ARC_NETWORK: viteEnv.VITE_ARC_NETWORK,
  VITE_ARC_CHAIN_ID: viteEnv.VITE_ARC_CHAIN_ID,
  VITE_ARC_RPC_URL: viteEnv.VITE_ARC_RPC_URL,
  VITE_ARC_FALLBACK_RPC_URL: viteEnv.VITE_ARC_FALLBACK_RPC_URL,
  VITE_ARC_WALLET_RPC_URL: viteEnv.VITE_ARC_WALLET_RPC_URL,
  VITE_ARC_EXPLORER_URL: viteEnv.VITE_ARC_EXPLORER_URL,
  VITE_MEMEVERSE_FACTORY_ADDRESS: viteEnv.VITE_MEMEVERSE_FACTORY_ADDRESS,
  VITE_MARKET_FACTORY_ADDRESS: viteEnv.VITE_MARKET_FACTORY_ADDRESS,
  VITE_SETTLEMENT_ADDRESS: viteEnv.VITE_SETTLEMENT_ADDRESS,
  VITE_MEDIA_NFT_ADDRESS: viteEnv.VITE_MEDIA_NFT_ADDRESS,
  VITE_NFT_MARKETPLACE_ADDRESS: viteEnv.VITE_NFT_MARKETPLACE_ADDRESS,
  VITE_USDC_VAULT_ADDRESS: viteEnv.VITE_USDC_VAULT_ADDRESS,
  VITE_USDC_ADDRESS: viteEnv.VITE_USDC_ADDRESS,
});

/**
 * Arc is reached through two different sets of endpoints, for two unrelated reasons.
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
 * On testnet a previous release pointed both at the canonical `.arc.network` pair. Measured
 * against a burst matching one Markets page load: `rpc.quicknode.testnet.arc.network` answered 90
 * of 95 calls with HTTP 429, and `rpc.testnet.arc.network` throttled under sustained browser load
 * — so the fallback had nowhere to spill and the Markets page died with ARC RPC READ FAILED. The
 * same burst against `rpc.testnet.arc.io` and `rpc.drpc.testnet.arc.io` returned 95/95. Those two
 * therefore remain the testnet read transport; `npm run rpc:burst:check` is the check that would
 * have caught it.
 *
 * Mainnet uses the published docs.arc.io pair for reads and the published primary host for the
 * wallet. The two remain separate env fields even when they happen to name the same URL.
 */
export const ARC_READ_RPC_URL = ARC_NETWORK.readRpcUrl;
export const ARC_READ_FALLBACK_RPC_URL = ARC_NETWORK.readFallbackRpcUrl;

/**
 * The one endpoint a wallet is asked to store for Arc. Canonical, from the published chain
 * definition, and deliberately NOT the application's read transport: a wallet keeps this for its
 * own use, so it should be the official host rather than whichever endpoint this page happens to
 * read through. Nothing in the browser fetches it.
 *
 * One URL, not a list. EIP-3085 accepts several, but offering a rate-limited second host would
 * only give a wallet a way to fail.
 */
export const ARC_WALLET_RPC_URL = ARC_NETWORK.walletRpcUrl;

/**
 * The product chain id as EIP-155 hex. Stated once, proven by test against the decimal id,
 * because a wallet network registration is written in hex and one wrong nibble registers a
 * different chain entirely — `0x4CF4B2` is 5043378, not Arc; `1243` is Archie Chain, not Arc.
 */
export const ARC_CHAIN_ID = ARC_NETWORK.chainId;
export const ARC_CHAIN_ID_HEX = ARC_NETWORK.chainIdHex;
export const ARC_IS_MAINNET = ARC_NETWORK.name === 'mainnet';

function chainDefinition(catalog, viemChain, { readRpc, readFallback, websocket, fallbackWebsocket, explorerUrl, explorerName, explorerApiUrl }) {
  return {
    ...viemChain,
    // viem's Arc mainnet definition ships with no Multicall3 entry, so every
    // marketPublicClient.multicall throws before a factory read. The canonical
    // contract is on both Arc networks (docs.arc.io contract addresses).
    contracts: {
      ...viemChain.contracts,
      multicall3: viemChain.contracts?.multicall3 ?? {
        address: ARC_MULTICALL3_ADDRESS,
        blockCreated: 0,
      },
    },
    name: catalog.label,
    rpcUrls: {
      default: {
        http: [readRpc, readFallback],
        webSocket: [websocket],
      },
      public: {
        http: [readFallback],
        webSocket: [fallbackWebsocket],
      },
    },
    blockExplorers: {
      default: {
        name: explorerName,
        url: explorerUrl,
        apiUrl: explorerApiUrl,
      },
    },
  };
}

/**
 * Always-defined chain objects for both Arc networks. Wagmi/Reown must be able to represent
 * whichever one the wallet is sitting on; product writes stay gated on `arc.id` (the configured
 * network) rather than on whichever of these the wallet last used.
 */
export const arcTestnet = chainDefinition(ARC_NETWORKS.testnet, viemArcTestnet, {
  readRpc: ARC_NETWORK.name === 'testnet' ? ARC_READ_RPC_URL : ARC_NETWORKS.testnet.readRpcUrl,
  readFallback: ARC_NETWORK.name === 'testnet' ? ARC_READ_FALLBACK_RPC_URL : ARC_NETWORKS.testnet.readFallbackRpcUrl,
  websocket: ARC_NETWORKS.testnet.websocketUrl,
  fallbackWebsocket: ARC_NETWORKS.testnet.fallbackWebsocketUrl,
  explorerUrl: ARC_NETWORK.name === 'testnet' ? ARC_NETWORK.explorerUrl : ARC_NETWORKS.testnet.explorerUrl,
  explorerName: ARC_NETWORKS.testnet.explorerName,
  explorerApiUrl: ARC_NETWORKS.testnet.explorerApiUrl,
});

export const arcMainnet = chainDefinition(ARC_NETWORKS.mainnet, viemArcMainnet, {
  readRpc: ARC_NETWORK.name === 'mainnet' ? ARC_READ_RPC_URL : ARC_NETWORKS.mainnet.readRpcUrl,
  readFallback: ARC_NETWORK.name === 'mainnet' ? ARC_READ_FALLBACK_RPC_URL : ARC_NETWORKS.mainnet.readFallbackRpcUrl,
  websocket: ARC_NETWORKS.mainnet.websocketUrl,
  fallbackWebsocket: ARC_NETWORKS.mainnet.fallbackWebsocketUrl,
  explorerUrl: ARC_NETWORK.name === 'mainnet' ? ARC_NETWORK.explorerUrl : ARC_NETWORKS.mainnet.explorerUrl,
  explorerName: ARC_NETWORKS.mainnet.explorerName,
  explorerApiUrl: ARC_NETWORKS.mainnet.explorerApiUrl,
});

/**
 * The chain as MemeVerse READS it. `rpcUrls` here is the application transport and nothing else —
 * the wallet-registration payload is built from `ARC_WALLET_RPC_URL` and never from this object,
 * which is the coupling that caused the rollback.
 */
export const arc = ARC_IS_MAINNET ? arcMainnet : arcTestnet;

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
  usdc: ARC_NETWORK.usdc,
  memo: ARC_NETWORK.memo,
  multicall3From: ARC_NETWORK.multicall3From,
  memeVerseSettlement: ARC_NETWORK.settlement,
  memeVerseFactory: ARC_NETWORK.factory,
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
  phase: ARC_IS_MAINNET ? 'ARC MAINNET / AUTONOMY PAUSED' : 'FINAL MVP / PUBLIC TESTNET',
  realAssets: ARC_IS_MAINNET ? 'ARC USDC + MEME TOKENS' : 'ARC TESTNET USDC + MEME TOKENS',
  confirmationsRequired: 1,
  // Memo CallFrom preserves only a directly signing EOA as msg.sender, so it routes the manual
  // Developer-Controlled Wallet path alone. The Agent Wallet is an ERC-4337 smart account and
  // calls its own settlement contract directly instead.
  transactionMemos: 'MANUAL SETTLEMENT ROUTE / EOA ONLY',
  batchedTransactions: ARC_IS_MAINNET ? 'FACTORY + ONE SEED MARKET' : 'TESTNET READY / EOA ONLY',
  postQuantum: 'ROADMAP / NOT YET AVAILABLE',
  appKit: ARC_IS_MAINNET ? 'NOT USED ON MAINNET' : 'SWAP ESTIMATE LIVE / SERVER-ONLY',
  // Two isolated routes on testnet: the Agent Wallet executes with no per-payout human approval,
  // and the manual operator route still requires a wallet-signed session. Mainnet does not run
  // either Circle route. Creator and treasury fees still settle inside the trade.
  agentExecution: ARC_IS_MAINNET
    ? 'NOT LIVE — FEES SETTLE INSIDE THE TRADE'
    : 'AUTONOMOUS AGENT WALLET + MANUAL OPERATOR ROUTES',
});

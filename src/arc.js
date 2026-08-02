import { arcTestnet as viemArcTestnet } from 'viem/chains';

export const ARC_RPC_URL =
  import.meta.env.VITE_ARC_RPC_URL?.trim() || 'https://rpc.testnet.arc.network';

export const arc = {
  ...viemArcTestnet,
  rpcUrls: {
    default: {
      http: [ARC_RPC_URL],
      webSocket: ['wss://rpc.testnet.arc.network'],
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
  realAssets: false,
  confirmationsRequired: 1,
  transactionMemos: 'LIVE IN MEMEVERSE / EOA ONLY',
  batchedTransactions: 'TESTNET READY / EOA ONLY',
  postQuantum: 'ROADMAP / NOT YET AVAILABLE',
  appKit: 'SWAP ESTIMATE LIVE / SERVER-ONLY',
  agentExecution: 'HUMAN APPROVAL REQUIRED',
});

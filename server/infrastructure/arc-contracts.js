import {
  encodeFunctionData,
  getAddress,
  keccak256,
  stringToHex,
} from 'viem';

export const ARC_USDC_ADDRESS = getAddress('0x3600000000000000000000000000000000000000');
export const ARC_MEMO_ADDRESS = getAddress('0x5294E9927c3306DcBaDb03fe70b92e01cCede505');
export const ARC_NATIVE_USDC_EMITTER = getAddress('0xfffffffffffffffffffffffffffffffffffffffe');

export const settlementAbi = [
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'settlementId', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'SettlementExecuted',
    anonymous: false,
    inputs: [
      { name: 'settlementId', type: 'bytes32', indexed: true },
      { name: 'operator', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
];

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
  {
    type: 'event',
    name: 'Memo',
    anonymous: false,
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'target', type: 'address', indexed: true },
      { name: 'callDataHash', type: 'bytes32', indexed: false },
      { name: 'memoId', type: 'bytes32', indexed: true },
      { name: 'memo', type: 'bytes', indexed: false },
      { name: 'memoIndex', type: 'uint256', indexed: false },
    ],
  },
];

export const usdcAbi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    anonymous: false,
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
];

export function createArcSettlementExecutionPlan(record, settlementContractAddress) {
  const targetContract = getAddress(settlementContractAddress);
  const callData = encodeFunctionData({
    abi: settlementAbi,
    functionName: 'settle',
    args: [record.memoId, getAddress(record.recipient), BigInt(record.amount.creatorPayoutUnits)],
  });
  const memoData = stringToHex(`memeverse:settlement:${record.id}`);
  const memoCallData = encodeFunctionData({
    abi: memoAbi,
    functionName: 'memo',
    args: [targetContract, callData, record.memoId, memoData],
  });

  return {
    provider: 'CIRCLE_DEVELOPER_CONTROLLED_WALLET',
    operation: 'ARC_MEMO_CONTRACT_SETTLEMENT',
    chain: 'ARC-TESTNET',
    asset: 'USDC',
    recipient: record.recipient,
    amountUsdc: record.amount.creatorPayoutUsdc,
    amountUnits: record.amount.creatorPayoutUnits,
    memoId: record.memoId,
    memoContract: ARC_MEMO_ADDRESS,
    targetContract,
    callData,
    callDataHash: keccak256(callData),
    memoData,
    memoCallData,
    requiresSigning: true,
    broadcast: false,
  };
}

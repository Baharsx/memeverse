import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  keccak256,
} from 'viem';
import { arcTestnet } from 'viem/chains';
import { DomainError } from '../domain/errors.js';
import {
  ARC_MEMO_ADDRESS,
  ARC_USDC_ADDRESS,
  memoAbi,
  settlementAbi,
  usdcAbi,
} from './arc-contracts.js';

function sameAddress(left, right) {
  return Boolean(left && right && getAddress(left) === getAddress(right));
}

function decodeMatchingLog(log, address, abi, eventName) {
  if (!sameAddress(log.address, address)) return null;
  try {
    const decoded = decodeEventLog({ abi, eventName, data: log.data, topics: log.topics });
    return decoded.eventName === eventName ? { log, args: decoded.args } : null;
  } catch {
    return null;
  }
}

export class ArcSettlementIndexer {
  constructor({ rpcUrl, settlementContractAddress, client }) {
    this.settlementContractAddress = settlementContractAddress
      ? getAddress(settlementContractAddress)
      : null;
    this.client = client ?? createPublicClient({
      chain: arcTestnet,
      transport: http(rpcUrl),
    });
  }

  configuration() {
    return {
      configured: Boolean(this.settlementContractAddress),
      settlementContract: this.settlementContractAddress,
      memoContract: ARC_MEMO_ADDRESS,
    };
  }

  async verify(record) {
    if (!this.settlementContractAddress) {
      throw new DomainError('ARC_INDEXER_NOT_CONFIGURED', 'Arc settlement contract is not configured.', {
        status: 503,
      });
    }
    if (!record.transactionHash || !record.executionPlan) {
      return { status: 'PENDING', checkedAt: new Date().toISOString() };
    }

    const hash = record.transactionHash;
    let receipt;
    let transaction;
    try {
      [receipt, transaction] = await Promise.all([
        this.client.getTransactionReceipt({ hash }),
        this.client.getTransaction({ hash }),
      ]);
    } catch (error) {
      if (error?.name === 'TransactionReceiptNotFoundError' || error?.name === 'TransactionNotFoundError') {
        return { status: 'PENDING', checkedAt: new Date().toISOString() };
      }
      throw error;
    }

    const failures = [];
    if (receipt.status !== 'success') failures.push('RECEIPT_REVERTED');
    if (!sameAddress(transaction.to, ARC_MEMO_ADDRESS)) failures.push('MEMO_TARGET_MISMATCH');
    if (keccak256(record.executionPlan.callData) !== record.executionPlan.callDataHash) {
      failures.push('PERSISTED_CALLDATA_HASH_MISMATCH');
    }

    const memoEvents = receipt.logs
      .map((log) => decodeMatchingLog(log, ARC_MEMO_ADDRESS, memoAbi, 'Memo'))
      .filter(Boolean);
    const settlementEvents = receipt.logs
      .map((log) => decodeMatchingLog(log, this.settlementContractAddress, settlementAbi, 'SettlementExecuted'))
      .filter(Boolean);
    const transferEvents = receipt.logs
      .map((log) => decodeMatchingLog(log, ARC_USDC_ADDRESS, usdcAbi, 'Transfer'))
      .filter(Boolean);

    const memo = memoEvents.find(({ args }) => args.memoId === record.memoId);
    const settlement = settlementEvents.find(({ args }) => args.settlementId === record.memoId);
    const expectedOperator = record.circle?.sourceAddress ?? transaction.from;
    const expectedAmount = BigInt(record.amount.creatorPayoutUnits);
    const transfer = transferEvents.find(({ args }) => (
      sameAddress(args.from, expectedOperator)
      && sameAddress(args.to, record.recipient)
      && args.value === expectedAmount
    ));

    if (!memo) failures.push('MEMO_EVENT_MISSING');
    else {
      if (!sameAddress(memo.args.sender, expectedOperator)) failures.push('MEMO_SENDER_MISMATCH');
      if (!sameAddress(memo.args.target, this.settlementContractAddress)) failures.push('MEMO_TARGET_EVENT_MISMATCH');
      if (memo.args.callDataHash !== record.executionPlan.callDataHash) failures.push('MEMO_CALLDATA_HASH_MISMATCH');
      if (memo.args.memo !== record.executionPlan.memoData) failures.push('MEMO_DATA_MISMATCH');
    }
    if (!settlement) failures.push('SETTLEMENT_EVENT_MISSING');
    else {
      if (!sameAddress(settlement.args.operator, expectedOperator)) failures.push('SETTLEMENT_OPERATOR_MISMATCH');
      if (!sameAddress(settlement.args.recipient, record.recipient)) failures.push('SETTLEMENT_RECIPIENT_MISMATCH');
      if (settlement.args.amount !== expectedAmount) failures.push('SETTLEMENT_AMOUNT_MISMATCH');
    }
    if (!transfer) failures.push('USDC_TRANSFER_EVENT_MISSING');

    const checkedAt = new Date().toISOString();
    if (failures.length) {
      return {
        status: 'MISMATCH',
        failures,
        transactionHash: hash,
        blockNumber: Number(receipt.blockNumber),
        checkedAt,
      };
    }
    return {
      status: 'VERIFIED',
      transactionHash: hash,
      blockHash: receipt.blockHash,
      blockNumber: Number(receipt.blockNumber),
      transactionIndex: receipt.transactionIndex,
      memoIndex: memo.args.memoIndex.toString(),
      eventLogIndex: Number(settlement.log.logIndex),
      checkedAt,
    };
  }
}

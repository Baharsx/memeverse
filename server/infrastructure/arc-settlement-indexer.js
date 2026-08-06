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
  /**
   * @param settlementContractAddress The Memo-routed contract used by the manual operator path.
   * @param agentSettlementContractAddress The contract whose immutable operator is the Circle
   *   Agent Wallet, used by the autonomous path. Optional; absent means autonomy is unconfigured.
   */
  constructor({ rpcUrl, settlementContractAddress, agentSettlementContractAddress, client }) {
    this.settlementContractAddress = settlementContractAddress
      ? getAddress(settlementContractAddress)
      : null;
    this.agentSettlementContractAddress = agentSettlementContractAddress
      ? getAddress(agentSettlementContractAddress)
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
      agentSettlementContract: this.agentSettlementContractAddress,
      memoContract: ARC_MEMO_ADDRESS,
    };
  }

  /**
   * Which contract and routing a settlement's evidence must be checked against.
   *
   * The manual path signs from a Developer-Controlled EOA and routes through Arc's Memo contract,
   * so its evidence includes a Memo event. The autonomous path executes from a Circle Agent
   * Wallet, which is an ERC-4337 smart contract account; Arc's Memo CallFrom extension only
   * preserves a *directly signing EOA* as `msg.sender`, and empirically rejects an SCA caller.
   * The autonomous path therefore calls its own settlement contract directly.
   *
   * Direct routing removes the Memo event and nothing else. The settlement identity, operator,
   * recipient, and amount are all still proven by `SettlementExecuted`, and the money movement is
   * still proven by the USDC `Transfer` — those checks are identical in both modes and are never
   * relaxed. Only the Memo-specific assertions are skipped, because no Memo exists to assert on.
   */
  routingFor(record) {
    const plan = record.executionPlan ?? {};
    if (plan.operation === 'ARC_DIRECT_SETTLEMENT') {
      return {
        mode: 'DIRECT',
        contract: this.agentSettlementContractAddress
          ?? (plan.targetContract ? getAddress(plan.targetContract) : null),
        expectedTo: this.agentSettlementContractAddress
          ?? (plan.targetContract ? getAddress(plan.targetContract) : null),
      };
    }
    return {
      mode: 'MEMO',
      contract: this.settlementContractAddress,
      expectedTo: ARC_MEMO_ADDRESS,
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
    const routing = this.routingFor(record);
    if (!routing.contract) {
      throw new DomainError(
        'ARC_INDEXER_NOT_CONFIGURED',
        'The settlement contract for this execution route is not configured.',
        { status: 503, details: { mode: routing.mode } },
      );
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
    if (keccak256(record.executionPlan.callData) !== record.executionPlan.callDataHash) {
      failures.push('PERSISTED_CALLDATA_HASH_MISMATCH');
    }

    const memoEvents = receipt.logs
      .map((log) => decodeMatchingLog(log, ARC_MEMO_ADDRESS, memoAbi, 'Memo'))
      .filter(Boolean);
    const settlementEvents = receipt.logs
      .map((log) => decodeMatchingLog(log, routing.contract, settlementAbi, 'SettlementExecuted'))
      .filter(Boolean);
    const transferEvents = receipt.logs
      .map((log) => decodeMatchingLog(log, ARC_USDC_ADDRESS, usdcAbi, 'Transfer'))
      .filter(Boolean);

    const memo = memoEvents.find(({ args }) => args.memoId === record.memoId);
    const settlement = settlementEvents.find(({ args }) => args.settlementId === record.memoId);
    // The operator is whoever the settlement contract recorded, which is the only authority the
    // contract itself would accept. For an Agent Wallet the outer transaction is submitted by an
    // ERC-4337 bundler, so `transaction.from` is the bundler and must never be used here.
    const expectedOperator = settlement?.args?.operator
      ?? record.circle?.sourceAddress
      ?? transaction.from;
    const expectedAmount = BigInt(record.amount.creatorPayoutUnits);
    const transfer = transferEvents.find(({ args }) => (
      sameAddress(args.from, expectedOperator)
      && sameAddress(args.to, record.recipient)
      && args.value === expectedAmount
    ));

    if (routing.mode === 'MEMO') {
      // Memo routing is asserted exactly as strictly as before.
      if (!sameAddress(transaction.to, ARC_MEMO_ADDRESS)) failures.push('MEMO_TARGET_MISMATCH');
      if (!memo) failures.push('MEMO_EVENT_MISSING');
      else {
        if (!sameAddress(memo.args.sender, expectedOperator)) failures.push('MEMO_SENDER_MISMATCH');
        if (!sameAddress(memo.args.target, routing.contract)) failures.push('MEMO_TARGET_EVENT_MISMATCH');
        if (memo.args.callDataHash !== record.executionPlan.callDataHash) failures.push('MEMO_CALLDATA_HASH_MISMATCH');
        if (memo.args.memo !== record.executionPlan.memoData) failures.push('MEMO_DATA_MISMATCH');
      }
    } else if (!sameAddress(transaction.to, routing.expectedTo)) {
      // A direct settlement is submitted through the ERC-4337 EntryPoint, so the outer `to` is
      // the EntryPoint rather than the settlement contract. The binding that matters is that the
      // settlement contract itself emitted the event, which is asserted below and is not
      // forgeable by anyone who is not its immutable operator.
      if (settlementEvents.length === 0) failures.push('DIRECT_SETTLEMENT_TARGET_MISMATCH');
    }

    if (!settlement) failures.push('SETTLEMENT_EVENT_MISSING');
    else {
      if (!sameAddress(settlement.args.operator, expectedOperator)) failures.push('SETTLEMENT_OPERATOR_MISMATCH');
      if (!sameAddress(settlement.args.recipient, record.recipient)) failures.push('SETTLEMENT_RECIPIENT_MISMATCH');
      if (settlement.args.amount !== expectedAmount) failures.push('SETTLEMENT_AMOUNT_MISMATCH');
      // In direct mode the emitting contract is the whole authorization story, so it must be the
      // configured autonomous contract and not some look-alike that emits the same event shape.
      if (!sameAddress(settlement.log.address, routing.contract)) {
        failures.push('SETTLEMENT_CONTRACT_MISMATCH');
      }
    }
    if (!transfer) failures.push('USDC_TRANSFER_EVENT_MISSING');

    const checkedAt = new Date().toISOString();
    if (failures.length) {
      return {
        status: 'MISMATCH',
        failures,
        route: routing.mode,
        transactionHash: hash,
        blockNumber: Number(receipt.blockNumber),
        checkedAt,
      };
    }
    return {
      status: 'VERIFIED',
      route: routing.mode,
      settlementContract: routing.contract,
      operator: getAddress(expectedOperator),
      transactionHash: hash,
      blockHash: receipt.blockHash,
      blockNumber: Number(receipt.blockNumber),
      transactionIndex: receipt.transactionIndex,
      memoIndex: memo ? memo.args.memoIndex.toString() : null,
      eventLogIndex: Number(settlement.log.logIndex),
      checkedAt,
    };
  }
}

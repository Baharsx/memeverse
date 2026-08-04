import { keccak256, stringToHex } from 'viem';

/**
 * The exact execution parameters an operator approves.
 *
 * Both the authorization layer (which issues and consumes approvals) and the settlement domain
 * (which claims execution) hash this identically, so a settlement mutated between approval and
 * submission can never be executed under the older approval.
 */
export function settlementExecutionBinding(record) {
  return {
    settlementId: record.id,
    chainId: record.chainId,
    recipient: record.recipient,
    creatorPayoutUnits: record.amount?.creatorPayoutUnits ?? null,
    memoId: record.memoId,
    settlementContract: record.executionPlan?.targetContract ?? null,
    memoContract: record.executionPlan?.memoContract ?? null,
    callDataHash: record.executionPlan?.callDataHash ?? null,
  };
}

export function settlementExecutionBindingHash(record) {
  return keccak256(stringToHex(JSON.stringify(settlementExecutionBinding(record))));
}

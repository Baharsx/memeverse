import { keccak256, stringToHex } from 'viem';

export const transactionPhases = Object.freeze([
  'REQUESTED',
  'WALLET_SIGNATURE',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
]);

function randomSuffix() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().slice(0, 8).toUpperCase();
  }

  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

export function createReferenceId(scope = 'ACTION') {
  const timestamp = Date.now().toString(36).toUpperCase();
  return `MMV-${scope}-${timestamp}-${randomSuffix()}`;
}

export function createSimulationRecord(action, referenceId) {
  const reference = referenceId.trim() || createReferenceId(action);

  return Object.freeze({
    action,
    reference,
    memoId: keccak256(stringToHex(reference)),
    state: 'SIMULATION',
    broadcast: false,
    createdAt: new Date().toISOString(),
  });
}

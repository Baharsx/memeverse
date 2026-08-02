import { DomainError } from './errors.js';

export const settlementStates = Object.freeze({
  PREPARED: 'PREPARED',
  AWAITING_SIGNATURE: 'AWAITING_SIGNATURE',
  INITIATED: 'INITIATED',
  QUEUED: 'QUEUED',
  CLEARED: 'CLEARED',
  SENT: 'SENT',
  STUCK: 'STUCK',
  CONFIRMED: 'CONFIRMED',
  COMPLETE: 'COMPLETE',
  DENIED: 'DENIED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
});

const transitions = Object.freeze({
  PREPARED: new Set(['AWAITING_SIGNATURE', 'EXPIRED', 'CANCELLED']),
  AWAITING_SIGNATURE: new Set(['INITIATED', 'CLEARED', 'QUEUED', 'SENT', 'CONFIRMED', 'COMPLETE', 'EXPIRED', 'CANCELLED', 'FAILED', 'DENIED']),
  INITIATED: new Set(['CLEARED', 'QUEUED', 'SENT', 'CONFIRMED', 'COMPLETE', 'FAILED', 'DENIED', 'CANCELLED']),
  CLEARED: new Set(['QUEUED', 'SENT', 'CONFIRMED', 'COMPLETE', 'FAILED', 'DENIED', 'CANCELLED']),
  QUEUED: new Set(['SENT', 'CONFIRMED', 'COMPLETE', 'CANCELLED', 'FAILED', 'DENIED']),
  SENT: new Set(['STUCK', 'CONFIRMED', 'COMPLETE', 'FAILED']),
  STUCK: new Set(['SENT', 'CONFIRMED', 'COMPLETE', 'FAILED']),
  CONFIRMED: new Set(['COMPLETE', 'FAILED']),
  COMPLETE: new Set(),
  DENIED: new Set(),
  EXPIRED: new Set(),
  CANCELLED: new Set(),
  FAILED: new Set(),
});

export function transitionSettlement(record, nextState, now, metadata = {}) {
  if (record.state === nextState) return record;
  if (!transitions[record.state]?.has(nextState)) {
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `Cannot transition settlement from ${record.state} to ${nextState}.`,
      { status: 409, details: { currentState: record.state, nextState } },
    );
  }

  return {
    ...record,
    state: nextState,
    updatedAt: now,
    history: [
      ...record.history,
      { state: nextState, at: now, ...metadata },
    ],
  };
}

import { DomainError } from './errors.js';

const successRank = Object.freeze({
  INITIATED: 1,
  CLEARED: 2,
  QUEUED: 3,
  SENT: 4,
  STUCK: 4,
  CONFIRMED: 5,
  COMPLETE: 6,
});

const terminalStates = new Set(['FAILED', 'DENIED', 'CANCELLED']);

export function validateCircleState(state) {
  if (!(state in successRank) && !terminalStates.has(state)) {
    throw new DomainError('UNKNOWN_CIRCLE_STATE', `Unsupported Circle transaction state: ${state}.`, {
      status: 502,
    });
  }
  return state;
}

export function shouldApplyCircleState(currentState, incomingState) {
  validateCircleState(incomingState);
  if (terminalStates.has(currentState) || currentState === 'COMPLETE') return false;
  if (terminalStates.has(incomingState)) return true;
  const currentRank = successRank[currentState] ?? 0;
  return successRank[incomingState] >= currentRank;
}

export function circleStateIndicatesBroadcast(state, transactionHash) {
  return Boolean(transactionHash) || ['SENT', 'STUCK', 'CONFIRMED', 'COMPLETE'].includes(state);
}

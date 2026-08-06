import { keccak256, stringToHex } from 'viem';
import { DomainError } from './errors.js';
import { executionModes } from './execution-mode.js';

/**
 * Authority for an autonomous payout, mintable only inside this process.
 *
 * The brand is a module-private Symbol. HTTP bodies arrive as parsed JSON, and JSON cannot carry
 * a Symbol-keyed property, so no request — however crafted — can produce an object that passes
 * `isAutonomousAuthority`. That is the whole trust boundary: `AUTONOMOUS_POLICY` is enabled as an
 * execution mode, but the only way to obtain an authority carrying it is to call this factory
 * from server-side code that has already validated real onchain evidence.
 *
 * The authority deliberately carries no secret. It is a binding of identities and hashes, so
 * persisting it in the audit trail leaks nothing reusable.
 */

const AUTONOMOUS_BRAND = Symbol('memeverse.autonomousExecutionAuthority');

export const AUTONOMOUS_AUTHORITY_VERSION = 'AUTONOMOUS_AUTHORITY_V1';

/**
 * Deterministic, non-secret reference for one autonomous execution.
 *
 * Bound to the settlement, the market, the creator, the evidence, the policy, and the epoch, so
 * a recovery of the same work reproduces the same reference while any change of inputs produces
 * a different one.
 */
export function autonomousAuthorizationRef({
  settlementId, marketAddress, creatorAddress, evidenceDigest, policyVersion, epoch,
}) {
  return keccak256(stringToHex(JSON.stringify({
    kind: AUTONOMOUS_AUTHORITY_VERSION,
    settlementId,
    marketAddress: String(marketAddress).toLowerCase(),
    creatorAddress: String(creatorAddress).toLowerCase(),
    evidenceDigest,
    policyVersion,
    epoch,
  })));
}

export function mintAutonomousAuthority({
  settlementId,
  marketAddress,
  creatorAddress,
  evidenceDigest,
  policyVersion,
  metricVersion,
  epoch,
  decidedAt,
  expiresAt,
  anchorBlockNumber,
  anchorBlockHash,
  amountUnits,
}) {
  if (!settlementId || !marketAddress || !creatorAddress || !evidenceDigest) {
    throw new DomainError(
      'AUTONOMOUS_AUTHORITY_INCOMPLETE',
      'An autonomous authority must bind a settlement, market, creator, and evidence digest.',
      { status: 500 },
    );
  }
  const authority = {
    mode: executionModes.AUTONOMOUS_POLICY,
    version: AUTONOMOUS_AUTHORITY_VERSION,
    // No operator and no session: this payout was not approved by a human, and the audit trail
    // must say so plainly rather than borrowing an operator's identity.
    operatorAddress: null,
    sessionId: null,
    authorizationRef: autonomousAuthorizationRef({
      settlementId, marketAddress, creatorAddress, evidenceDigest, policyVersion, epoch,
    }),
    bindingHash: null,
    authorizedAt: decidedAt,
    expiresAt,
    agent: Object.freeze({
      marketAddress,
      creatorAddress,
      evidenceDigest,
      policyVersion,
      metricVersion,
      epoch,
      anchorBlockNumber: anchorBlockNumber === undefined ? null : String(anchorBlockNumber),
      anchorBlockHash: anchorBlockHash ?? null,
      amountUnits: amountUnits === undefined ? null : String(amountUnits),
    }),
  };
  Object.defineProperty(authority, AUTONOMOUS_BRAND, {
    value: true, enumerable: false, writable: false, configurable: false,
  });
  return Object.freeze(authority);
}

export function isAutonomousAuthority(authority) {
  return authority?.[AUTONOMOUS_BRAND] === true;
}

/** Rejects an expired autonomous decision, so stale evidence can never be executed later. */
export function assertAutonomousAuthorityFresh(authority, now) {
  if (!authority.expiresAt) return authority;
  if (now.getTime() > new Date(authority.expiresAt).getTime()) {
    throw new DomainError(
      'AUTONOMOUS_DECISION_EXPIRED',
      'The autonomous decision expired before it could be executed.',
      { status: 409, details: { expiresAt: authority.expiresAt } },
    );
  }
  return authority;
}

import { DomainError } from './errors.js';

/**
 * Signal provenance is assigned by the server, never by an HTTP client.
 *
 * `OPERATOR_INPUT` is the only class reachable from the browser API and only through an
 * authenticated operator session. The trusted classes are reserved for internal infrastructure
 * (`AgentDecisionService.decideTrusted`) that Phase 6B will supply; no code path fabricates them
 * today.
 */
export const signalProvenance = Object.freeze({
  OPERATOR_INPUT: 'OPERATOR_INPUT',
  ONCHAIN_INDEXER: 'ONCHAIN_INDEXER',
  ANALYTICS_PIPELINE: 'ANALYTICS_PIPELINE',
});

export const trustedSignalProvenance = Object.freeze(new Set([
  signalProvenance.ONCHAIN_INDEXER,
  signalProvenance.ANALYTICS_PIPELINE,
]));

export function assertKnownProvenance(provenance) {
  if (!Object.values(signalProvenance).includes(provenance)) {
    throw new DomainError('UNKNOWN_SIGNAL_PROVENANCE', 'Unsupported agent signal provenance.', {
      status: 500,
      details: { provenance: null },
    });
  }
  return provenance;
}

export function assertTrustedProvenance(provenance) {
  assertKnownProvenance(provenance);
  if (!trustedSignalProvenance.has(provenance)) {
    throw new DomainError(
      'UNTRUSTED_SIGNAL_PROVENANCE',
      'Only internal trusted collectors may assign this signal provenance.',
      { status: 500 },
    );
  }
  return provenance;
}

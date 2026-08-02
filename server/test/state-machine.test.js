import assert from 'node:assert/strict';
import test from 'node:test';
import { transitionSettlement } from '../domain/settlement-state.js';

const prepared = {
  state: 'PREPARED',
  updatedAt: '2026-08-02T10:00:00.000Z',
  history: [{ state: 'PREPARED', at: '2026-08-02T10:00:00.000Z' }],
};

test('state machine records an allowed transition without mutating source', () => {
  const next = transitionSettlement(
    prepared,
    'AWAITING_SIGNATURE',
    '2026-08-02T10:01:00.000Z',
    { reason: 'TEST' },
  );

  assert.equal(prepared.state, 'PREPARED');
  assert.equal(next.state, 'AWAITING_SIGNATURE');
  assert.equal(next.history.length, 2);
  assert.equal(next.history[1].reason, 'TEST');
});

test('state machine rejects impossible financial lifecycle jumps', () => {
  assert.throws(
    () => transitionSettlement(prepared, 'COMPLETE', '2026-08-02T10:01:00.000Z'),
    { code: 'INVALID_STATE_TRANSITION', status: 409 },
  );
});

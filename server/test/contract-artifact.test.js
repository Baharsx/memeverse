import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('compiled settlement artifact exposes the guarded settlement surface', async () => {
  const artifact = JSON.parse(await readFile('contracts/artifacts/MemeVerseSettlement.json', 'utf8'));
  assert.match(artifact.compiler, /^0\.8\.30\+/);
  assert.equal(artifact.evmVersion, 'cancun');
  assert.ok(artifact.bytecode.startsWith('0x'));
  const settle = artifact.abi.find((entry) => entry.type === 'function' && entry.name === 'settle');
  const event = artifact.abi.find((entry) => entry.type === 'event' && entry.name === 'SettlementExecuted');
  assert.deepEqual(settle.inputs.map((input) => input.type), ['bytes32', 'address', 'uint256']);
  assert.deepEqual(event.inputs.map((input) => input.indexed), [true, true, true, false]);
});

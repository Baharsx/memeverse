import { readFile } from 'node:fs/promises';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';

loadLocalEnvironment();
const config = loadServerConfig();
if (!config.circleSettlementContractAddress) {
  console.error('CIRCLE_SETTLEMENT_CONTRACT_ADDRESS is required.');
  process.exitCode = 1;
} else {
  const artifact = JSON.parse(await readFile('contracts/artifacts/MemeVerseSettlement.json', 'utf8'));
  const compilerVersion = `v${artifact.compiler.split('.Emscripten')[0]}`;
  const endpoint = `https://testnet.arcscan.app/api/v2/smart-contracts/${config.circleSettlementContractAddress}/verification/via/standard-input`;
  const form = new FormData();
  form.set('compiler_version', compilerVersion);
  form.set('contract_name', artifact.contractName);
  form.set('autodetect_constructor_args', 'true');
  form.set('license_type', 'mit');
  form.set(
    'files[0]',
    new Blob([JSON.stringify(artifact.standardJsonInput)], { type: 'application/json' }),
    'standard-input.json',
  );

  const response = await fetch(endpoint, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.text();
  if (!response.ok) {
    throw new Error(`ArcScan verification failed with HTTP ${response.status}: ${payload}`);
  }
  console.log('ArcScan accepted the MemeVerseSettlement source verification request.');
  if (payload) console.log(payload);
}

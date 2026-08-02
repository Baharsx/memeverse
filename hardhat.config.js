import hardhatViem from '@nomicfoundation/hardhat-viem';
import hardhatViemAssertions from '@nomicfoundation/hardhat-viem-assertions';
import hardhatNodeTestRunner from '@nomicfoundation/hardhat-node-test-runner';
import { defineConfig } from 'hardhat/config';

export default defineConfig({
  plugins: [hardhatViem, hardhatViemAssertions, hardhatNodeTestRunner],
  solidity: {
    profiles: {
      default: {
        version: '0.8.30',
        settings: {
          evmVersion: 'cancun',
          viaIR: true,
          optimizer: { enabled: true, runs: 200 },
        },
      },
      production: {
        version: '0.8.30',
        settings: {
          evmVersion: 'cancun',
          viaIR: true,
          optimizer: { enabled: true, runs: 200 },
        },
      },
    },
  },
  paths: {
    sources: './contracts',
    tests: {
      nodejs: './contracts/test',
    },
  },
  networks: {
    hardhatMainnet: { type: 'edr-simulated', chainType: 'l1' },
  },
});

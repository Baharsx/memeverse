import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { DomainError } from '../domain/errors.js';
import { parseUnits } from 'viem';
import { createArcSettlementExecutionPlan } from './arc-contracts.js';

export function circleConfigurationStatus(config) {
  const missing = [];
  if (!config.circleApiKey) missing.push('CIRCLE_API_KEY');
  if (!config.circleEntitySecret) missing.push('CIRCLE_ENTITY_SECRET');
  if (!config.circleWalletId) missing.push('CIRCLE_WALLET_ID');
  if (!config.circleSettlementContractAddress) missing.push('CIRCLE_SETTLEMENT_CONTRACT_ADDRESS');
  return { configured: missing.length === 0, missing };
}

function circleError(error, operation) {
  const status = error?.response?.status;
  const providerCode = error?.response?.data?.code;
  return new DomainError(
    'CIRCLE_REQUEST_FAILED',
    `Circle ${operation} request failed.`,
    {
      status: status === 401 || status === 403 ? 502 : status === 429 ? 503 : 502,
      details: {
        operation,
        ...(status ? { providerStatus: status } : {}),
        ...(providerCode ? { providerCode } : {}),
      },
    },
  );
}

function parseArcUsdcInterfaceUnits(value) {
  const [whole, fraction = ''] = String(value).split('.');
  return parseUnits(`${whole}.${fraction.padEnd(6, '0').slice(0, 6)}`, 6);
}

export class CircleWalletGateway {
  constructor({ config, client }) {
    this.config = config;
    this.client = client;
  }

  configuration() {
    return circleConfigurationStatus(this.config);
  }

  requireConfigured() {
    const status = this.configuration();
    if (!status.configured || !this.client) {
      throw new DomainError(
        'CIRCLE_NOT_CONFIGURED',
        'Circle wallet execution is unavailable until all server-only credentials are configured.',
        { status: 503, details: { missing: status.missing } },
      );
    }
  }

  createExecutionPlan(record) {
    if (!this.config.circleSettlementContractAddress) {
      throw new DomainError(
        'ARC_SETTLEMENT_CONTRACT_NOT_CONFIGURED',
        'The Arc settlement contract address is not configured.',
        { status: 503 },
      );
    }
    return createArcSettlementExecutionPlan(record, this.config.circleSettlementContractAddress);
  }

  async readiness() {
    const configuration = this.configuration();
    if (!configuration.configured) {
      return { ...configuration, provider: 'CIRCLE_DEVELOPER_CONTROLLED_WALLET' };
    }
    try {
      const [walletResponse, balanceResponse] = await Promise.all([
        this.client.getWallet({ id: this.config.circleWalletId }),
        this.client.getWalletTokenBalance({ id: this.config.circleWalletId, includeAll: true }),
      ]);
      const wallet = walletResponse.data?.wallet;
      const balances = balanceResponse.data?.tokenBalances ?? [];
      const usdc = balances.find((balance) => (
        balance.token.blockchain === 'ARC-TESTNET'
        && balance.token.symbol === 'USDC'
      ));
      return {
        configured: true,
        provider: 'CIRCLE_DEVELOPER_CONTROLLED_WALLET',
        wallet: wallet ? {
          id: wallet.id,
          address: wallet.address,
          blockchain: wallet.blockchain,
          state: wallet.state,
          accountType: wallet.accountType,
        } : null,
        usdcBalance: usdc?.amount ?? '0',
      };
    } catch (error) {
      throw circleError(error, 'wallet readiness');
    }
  }

  async treasuryAvailableUnits() {
    const readiness = await this.readiness();
    if (!readiness.configured) {
      throw new DomainError('CIRCLE_NOT_CONFIGURED', 'Circle wallet is not configured.', {
        status: 503,
      });
    }
    // Circle reports Arc's native unified balance with 18-decimal precision. Contract
    // settlement uses the official six-decimal ERC-20 interface, so gas dust is rounded down.
    return parseArcUsdcInterfaceUnits(readiness.usdcBalance);
  }

  async executeSettlement(record) {
    this.requireConfigured();
    try {
      const plan = record.executionPlan ?? this.createExecutionPlan(record);
      // Deterministic per settlement, and reused verbatim when an execution claim resumes after
      // an unknown outcome, so Circle replays the original transaction instead of paying twice.
      const idempotencyKey = record.executionSubmission?.providerOperationKey ?? record.id;
      const response = await this.client.createContractExecutionTransaction({
        idempotencyKey,
        walletId: this.config.circleWalletId,
        contractAddress: plan.memoContract,
        callData: plan.memoCallData,
        refId: record.id,
        fee: {
          type: 'level',
          config: { feeLevel: this.config.circleFeeLevel },
        },
      });
      const transaction = response.data;
      if (!transaction?.id || !transaction?.state) {
        throw new Error('Circle returned an incomplete transaction response.');
      }
      return transaction;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw circleError(error, 'transfer');
    }
  }

  async getTransaction(id) {
    this.requireConfigured();
    try {
      const response = await this.client.getTransaction({ id });
      const transaction = response.data?.transaction;
      if (!transaction?.id || !transaction?.state) {
        throw new Error('Circle returned an incomplete transaction status.');
      }
      return transaction;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw circleError(error, 'transaction status');
    }
  }

  async getNotificationPublicKey(keyId) {
    this.requireConfigured();
    try {
      const response = await this.client.getNotificationSignature(keyId);
      const key = response.data;
      if (!key?.publicKey || key.algorithm !== 'ECDSA_SHA_256') {
        throw new Error('Circle returned an unsupported webhook key.');
      }
      return key;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw circleError(error, 'webhook public key');
    }
  }
}

export function createCircleWalletGateway(config, clientFactory = initiateDeveloperControlledWalletsClient) {
  const hasSdkCredentials = Boolean(config.circleApiKey && config.circleEntitySecret);
  const client = hasSdkCredentials
    ? clientFactory({
      apiKey: config.circleApiKey,
      entitySecret: config.circleEntitySecret,
      baseUrl: config.circleApiBaseUrl,
      userAgent: 'MemeVerse/1.2',
    })
    : null;
  return new CircleWalletGateway({ config, client });
}

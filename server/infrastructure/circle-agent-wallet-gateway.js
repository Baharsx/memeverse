import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPublicClient, getAddress, http, parseUnits } from 'viem';
import { DomainError } from '../domain/errors.js';
import { createArcDirectSettlementExecutionPlan } from './arc-contracts.js';

const run = promisify(execFile);

/**
 * Circle Agent Stack integration: payout execution through a Circle **Agent Wallet**.
 *
 * This is the real Agent Stack component, driven through Circle's official CLI
 * (`@circle-fin/cli`, package name and command surface as documented at
 * <https://developers.circle.com/agent-stack/agent-wallets>). The wallet is a Circle Agent Wallet
 * created with `circle wallet create` on `ARC-TESTNET`, backed by 2-of-2 MPC whose key shares are
 * never exposed to this process. Nothing here holds or handles a private key.
 *
 * Two properties of the real product shaped this design, and both are load-bearing:
 *
 *   1. An Agent Wallet is an **ERC-4337 smart contract account**, not an EOA. Arc's Memo
 *      `CallFrom` extension only preserves a directly signing EOA as `msg.sender`, and rejects an
 *      SCA caller. The autonomous path therefore calls its own settlement contract directly,
 *      rather than routing through Memo as the Developer-Controlled Wallet path does.
 *   2. `circle wallet execute` accepts `--idempotency-key`, and replays the original transaction
 *      for a repeated key. That is what lets this gateway satisfy the same provider-idempotency
 *      contract the Stage 1 execution-claim machinery is built on: a recovery after an unknown
 *      outcome reuses the settlement's `providerOperationKey` verbatim and can never create a
 *      second payout.
 *
 * The CLI is invoked via `execFile` with an argument vector — never a shell string — so no
 * settlement field can be interpreted as a shell metacharacter.
 */
export class CircleAgentWalletGateway {
  constructor({
    config,
    cliPath = 'circle',
    blockchain = 'ARC-TESTNET',
    execute = run,
    timeoutMs = 180_000,
    store,
    publicClient,
  }) {
    this.config = config;
    this.cliPath = cliPath;
    this.blockchain = blockchain;
    this.execute = execute;
    this.timeoutMs = timeoutMs;
    // Used only to resolve a previously created transaction back to its Arc hash.
    this.store = store;
    this.publicClient = publicClient;
  }

  configuration() {
    const missing = [];
    if (!this.config.agentWalletAddress) missing.push('AGENT_WALLET_ADDRESS');
    if (!this.config.agentSettlementContractAddress) missing.push('AGENT_SETTLEMENT_CONTRACT_ADDRESS');
    return {
      configured: missing.length === 0,
      missing,
      provider: 'CIRCLE_AGENT_WALLET',
    };
  }

  requireConfigured() {
    const status = this.configuration();
    if (!status.configured) {
      throw new DomainError(
        'AGENT_WALLET_NOT_CONFIGURED',
        'Circle Agent Wallet execution is unavailable until the agent wallet and its settlement contract are configured.',
        { status: 503, details: { missing: status.missing } },
      );
    }
  }

  /** Runs one Circle CLI command and parses its JSON envelope. */
  async #cli(args, operation) {
    let stdout;
    try {
      ({ stdout } = await this.execute(this.cliPath, [...args, '--output', 'json'], {
        timeout: this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      }));
    } catch (error) {
      // A non-zero exit still carries a JSON error envelope on stdout for most failures.
      const payload = this.#tryParse(error?.stdout);
      const code = payload?.error?.code;
      const message = payload?.error?.message ?? error?.message ?? 'Circle CLI invocation failed.';
      throw new DomainError('CIRCLE_AGENT_REQUEST_FAILED', `Circle Agent Wallet ${operation} failed.`, {
        status: 502,
        details: {
          operation,
          ...(code ? { providerCode: code } : {}),
          // Kept short and non-sensitive: the CLI never echoes credentials, but the message is
          // still truncated so an unexpected provider string cannot bloat the audit trail.
          providerMessage: String(message).slice(0, 200),
        },
      });
    }
    const parsed = this.#tryParse(stdout);
    if (!parsed?.data) {
      throw new DomainError('CIRCLE_AGENT_REQUEST_FAILED', `Circle Agent Wallet ${operation} returned no data.`, {
        status: 502, details: { operation },
      });
    }
    return parsed.data;
  }

  #tryParse(value) {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  /**
   * Reports whether the Agent Wallet is usable, in the same shape the settlement policy already
   * consumes from the Developer-Controlled Wallet gateway.
   */
  async readiness() {
    const configuration = this.configuration();
    if (!configuration.configured) return configuration;
    try {
      const status = await this.#cli(['wallet', 'status'], 'status');
      // `circle wallet status` reports one session per network keyed by network name. Arc Testnet
      // lives under `testnet`; a missing or non-VALID token means the agent cannot sign at all.
      const network = this.blockchain.endsWith('-TESTNET') || this.blockchain.includes('SEPOLIA')
        ? 'testnet'
        : 'mainnet';
      const session = status[network] ?? {};
      const balances = await this.#cli([
        'wallet', 'balance',
        '--address', this.config.agentWalletAddress,
        '--chain', this.blockchain,
      ], 'balance');
      // Prefer the six-decimal ERC-20 interface; Arc also reports an 18-decimal native view.
      const entries = balances.balances ?? [];
      const usdc = entries.find((entry) => entry.token?.symbol === 'USDC' && entry.token?.decimals === 6)
        ?? entries.find((entry) => entry.token?.symbol === 'USDC');
      return {
        configured: true,
        provider: 'CIRCLE_AGENT_WALLET',
        wallet: {
          address: getAddress(this.config.agentWalletAddress),
          blockchain: this.blockchain,
          // An Agent Wallet is an ERC-4337 smart contract account, and this says so rather than
          // pretending it is an EOA.
          accountType: 'SCA',
          state: session.tokenStatus === 'VALID' ? 'LIVE' : 'UNAVAILABLE',
        },
        usdcBalance: usdc?.amount ?? '0',
        // The session's status and expiry are operationally useful. The account email is
        // deliberately not surfaced: it is a personal identifier with no place in payout evidence.
        sessionStatus: session.tokenStatus ?? null,
        sessionExpiresIn: session.expiresIn ?? null,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('CIRCLE_AGENT_REQUEST_FAILED', 'Circle Agent Wallet readiness failed.', {
        status: 502,
      });
    }
  }

  /** Treasury capacity for the autonomous path is the Agent Wallet's own USDC balance. */
  async treasuryAvailableUnits() {
    const readiness = await this.readiness();
    if (!readiness.configured) {
      throw new DomainError('AGENT_WALLET_NOT_CONFIGURED', 'Circle Agent Wallet is not configured.', {
        status: 503,
      });
    }
    const [whole, fraction = ''] = String(readiness.usdcBalance).split('.');
    return parseUnits(`${whole}.${fraction.padEnd(6, '0').slice(0, 6)}`, 6);
  }

  createExecutionPlan(record) {
    this.requireConfigured();
    return createArcDirectSettlementExecutionPlan(
      record,
      this.config.agentSettlementContractAddress,
    );
  }

  /**
   * Executes the payout as the Agent Wallet.
   *
   * The idempotency key is the settlement's `providerOperationKey` — the same deterministic
   * identity the Developer-Controlled path uses — so a resumed claim replays the original Circle
   * operation instead of paying a second time.
   */
  async executeSettlement(record) {
    this.requireConfigured();
    const plan = record.executionPlan ?? this.createExecutionPlan(record);
    if (plan.operation !== 'ARC_DIRECT_SETTLEMENT') {
      throw new DomainError(
        'EXECUTION_PLAN_MISMATCH',
        'The Agent Wallet can only execute a direct settlement plan.',
        { status: 409, details: { operation: plan.operation ?? null } },
      );
    }
    const idempotencyKey = record.executionSubmission?.providerOperationKey ?? record.id;

    const data = await this.#cli([
      'wallet', 'execute',
      'settle(bytes32,address,uint256)',
      plan.memoId,
      getAddress(plan.recipient),
      String(plan.amountUnits),
      '--contract', getAddress(plan.targetContract),
      '--address', getAddress(this.config.agentWalletAddress),
      '--chain', this.blockchain,
      '--idempotency-key', idempotencyKey,
    ], 'settle');

    if (!data.id || !data.state) {
      throw new DomainError('CIRCLE_AGENT_REQUEST_FAILED', 'Circle returned an incomplete transaction.', {
        status: 502, details: { operation: 'settle' },
      });
    }
    return this.#normalize(data);
  }

  /**
   * Resolves a previously created transaction's state.
   *
   * The Circle CLI exposes no transaction-lookup verb, so rather than invent one this reads the
   * outcome from Arc — which is the stronger evidence anyway, and is exactly what reconciliation
   * would independently check. The settlement's own record supplies the hash, so the lookup
   * survives a process restart and never depends on in-memory state.
   *
   * A hash that is not yet mined reports `SENT` (broadcast, outcome pending) rather than a
   * terminal state, so an in-flight payout is never mistaken for a failed one.
   */
  async getTransaction(id) {
    this.requireConfigured();
    if (!this.store || !this.publicClient) {
      throw new DomainError(
        'CIRCLE_AGENT_REQUEST_FAILED',
        'Agent Wallet transaction lookup requires a settlement store and an Arc client.',
        { status: 503, details: { operation: 'transaction status' } },
      );
    }
    const record = await this.store.getByCircleTransactionId(id);
    const hash = record?.transactionHash;
    if (!hash) {
      // Circle accepted an operation whose hash was never persisted. Treat the outcome as
      // undetermined; it must not be reported as failed, because the payout may exist.
      return {
        id, state: 'SENT', blockchain: this.blockchain, txHash: null,
        sourceAddress: getAddress(this.config.agentWalletAddress),
        contractAddress: null, walletId: null, errorReason: null, errorDetails: null,
      };
    }
    let receipt;
    try {
      receipt = await this.publicClient.getTransactionReceipt({ hash });
    } catch (error) {
      if (error?.name === 'TransactionReceiptNotFoundError') {
        return {
          id, state: 'SENT', blockchain: this.blockchain, txHash: hash,
          sourceAddress: getAddress(this.config.agentWalletAddress),
          contractAddress: null, walletId: null, errorReason: null, errorDetails: null,
        };
      }
      throw new DomainError('CIRCLE_AGENT_REQUEST_FAILED', 'Arc receipt lookup failed.', {
        status: 502, details: { operation: 'transaction status' },
      });
    }
    return this.#normalize({
      id,
      state: receipt.status === 'success' ? 'COMPLETE' : 'FAILED',
      txHash: hash,
      errorReason: receipt.status === 'success' ? null : 'ARC_RECEIPT_REVERTED',
    });
  }

  /**
   * Maps a CLI transaction onto the shape the settlement service already merges.
   *
   * `sourceAddress` is deliberately the Agent Wallet, not the ERC-4337 bundler that submitted the
   * outer transaction, because the settlement contract's operator — and therefore the USDC
   * sender — is the wallet itself.
   */
  #normalize(transaction) {
    return {
      id: transaction.id,
      state: transaction.state,
      blockchain: transaction.blockchain ?? this.blockchain,
      txHash: transaction.txHash ?? null,
      sourceAddress: transaction.sourceAddress
        ? getAddress(transaction.sourceAddress)
        : getAddress(this.config.agentWalletAddress),
      contractAddress: transaction.contractAddress ?? null,
      // No Circle wallet UUID is surfaced: the autonomous audit trail identifies the executor by
      // its onchain address, which is already public, rather than by an internal identifier.
      walletId: null,
      errorReason: transaction.errorReason ?? null,
      errorDetails: transaction.errorDetails ?? null,
    };
  }
}

export function createCircleAgentWalletGateway(config, { store } = {}) {
  return new CircleAgentWalletGateway({
    config,
    store,
    publicClient: createPublicClient({ transport: http(config.arcRpcUrl) }),
  });
}

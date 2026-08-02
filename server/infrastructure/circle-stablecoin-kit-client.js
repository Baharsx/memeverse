import { formatUnits, parseUnits } from 'viem';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';

const ARC_TESTNET = 'Arc_Testnet';
const KIT_KEY_PATTERN = /^KIT_KEY:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/;
const DEFAULT_TIMEOUT_MS = 20_000;

const arcTestnetTokens = Object.freeze({
  USDC: Object.freeze({
    address: '0x3600000000000000000000000000000000000000',
    decimals: 6,
  }),
  EURC: Object.freeze({
    address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    decimals: 6,
  }),
  cirBTC: Object.freeze({
    address: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
    decimals: 8,
  }),
});

const feeItemSchema = z.object({
  token: z.string().min(1),
  amount: z.string().regex(/^\d+$/),
  decimals: z.number().int().nonnegative().optional(),
  symbol: z.string().min(1).optional(),
}).passthrough();

const stablecoinKitResponseSchema = z.object({
  tokenInAddress: z.string().min(1),
  tokenInChain: z.literal(ARC_TESTNET),
  tokenOutAddress: z.string().min(1),
  tokenOutChain: z.literal(ARC_TESTNET),
  fromAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  toAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string().regex(/^\d+$/),
  stopLimit: z.string().regex(/^\d+$/),
  estimatedAmount: z.string().regex(/^\d+$/),
  correlationId: z.string().uuid().optional(),
  fees: z.record(z.string(), z.array(feeItemSchema)).optional(),
  transaction: z.object({}).passthrough(),
}).passthrough();

function providerErrorStatus(status) {
  if (status === 429) return 503;
  if (status >= 400 && status < 500 && status !== 401 && status !== 403) return 422;
  return 502;
}

function providerError(response, body) {
  const providerCode = typeof body?.code === 'string' || typeof body?.code === 'number'
    ? String(body.code).slice(0, 100)
    : undefined;
  return new DomainError(
    response.status === 429 ? 'APP_KIT_RATE_LIMITED' : 'APP_KIT_PROVIDER_REJECTED',
    'Circle Stablecoin Kits could not prepare the swap estimate.',
    {
      status: providerErrorStatus(response.status),
      details: {
        providerStatus: response.status,
        ...(providerCode ? { providerCode } : {}),
      },
    },
  );
}

function normalizeFees(fees = {}) {
  return Object.entries(fees).flatMap(([type, items]) => items.map((item) => {
    const knownToken = Object.entries(arcTestnetTokens).find(([symbol, token]) => (
      symbol === item.symbol
      || symbol === item.token
      || token.address.toLowerCase() === item.token.toLowerCase()
    ));
    const decimals = item.decimals ?? knownToken?.[1].decimals;
    return {
      type,
      token: item.symbol ?? knownToken?.[0] ?? item.token,
      amount: decimals === undefined ? item.amount : formatUnits(BigInt(item.amount), decimals),
      ...(decimals === undefined ? { amountBaseUnits: item.amount } : {}),
    };
  }));
}

export class CircleStablecoinKitClient {
  constructor({
    kitKey,
    apiBaseUrl,
    walletGateway,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    if (!KIT_KEY_PATTERN.test(kitKey ?? '')) {
      throw new Error('CIRCLE_KIT_KEY must use the KIT_KEY:<id>:<secret> format.');
    }
    if (!walletGateway) throw new Error('A Circle wallet gateway is required.');
    this.kitKey = kitKey;
    this.apiBaseUrl = apiBaseUrl;
    this.walletGateway = walletGateway;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async estimateSwap(input) {
    const tokenIn = arcTestnetTokens[input.tokenIn];
    const tokenOut = arcTestnetTokens[input.tokenOut];
    if (!tokenIn || !tokenOut || input.tokenIn === input.tokenOut) {
      throw new DomainError('APP_KIT_UNSUPPORTED_ROUTE', 'The requested Arc Testnet swap route is unsupported.');
    }

    const readiness = await this.walletGateway.readiness();
    const wallet = readiness.wallet;
    if (!readiness.configured || !wallet?.address || wallet.blockchain !== 'ARC-TESTNET' || wallet.state !== 'LIVE') {
      throw new DomainError(
        'APP_KIT_WALLET_NOT_READY',
        'A live Circle developer-controlled wallet on Arc Testnet is required.',
        { status: 503 },
      );
    }

    let amount;
    try {
      amount = parseUnits(input.amountIn, tokenIn.decimals).toString();
    } catch {
      throw new DomainError('APP_KIT_INVALID_AMOUNT', 'The swap amount is invalid.');
    }
    if (BigInt(amount) <= 0n) {
      throw new DomainError('APP_KIT_INVALID_AMOUNT', 'The swap amount must be greater than zero.');
    }

    const payload = {
      tokenInAddress: tokenIn.address,
      tokenInChain: ARC_TESTNET,
      tokenOutAddress: tokenOut.address,
      tokenOutChain: ARC_TESTNET,
      fromAddress: wallet.address,
      toAddress: wallet.address,
      amount,
      slippageBps: 300,
    };

    let response;
    try {
      response = await this.fetchImpl(new URL('/v1/stablecoinKits/swap', this.apiBaseUrl), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${this.kitKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DomainError(
        error?.name === 'TimeoutError' ? 'APP_KIT_PROVIDER_TIMEOUT' : 'APP_KIT_PROVIDER_UNAVAILABLE',
        'Circle Stablecoin Kits is temporarily unavailable.',
        { status: error?.name === 'TimeoutError' ? 504 : 502 },
      );
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new DomainError('APP_KIT_INVALID_PROVIDER_RESPONSE', 'Circle returned an invalid response.', {
        status: 502,
      });
    }
    if (!response.ok) throw providerError(response, body);

    const parsed = stablecoinKitResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('APP_KIT_INVALID_PROVIDER_RESPONSE', 'Circle returned an invalid response.', {
        status: 502,
      });
    }
    const quote = parsed.data;
    const responseMatchesRequest = (
      quote.tokenInAddress.toLowerCase() === tokenIn.address.toLowerCase()
      && quote.tokenOutAddress.toLowerCase() === tokenOut.address.toLowerCase()
      && quote.fromAddress.toLowerCase() === wallet.address.toLowerCase()
      && quote.toAddress.toLowerCase() === wallet.address.toLowerCase()
      && quote.amount === amount
    );
    if (!responseMatchesRequest) {
      throw new DomainError('APP_KIT_PROVIDER_MISMATCH', 'Circle returned a quote for different parameters.', {
        status: 502,
      });
    }

    return {
      provider: 'CIRCLE_STABLECOIN_KITS',
      chain: ARC_TESTNET,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amountIn: input.amountIn,
      fromAddress: wallet.address,
      toAddress: wallet.address,
      stopLimit: { token: input.tokenOut, amount: formatUnits(BigInt(quote.stopLimit), tokenOut.decimals) },
      estimatedOutput: {
        token: input.tokenOut,
        amount: formatUnits(BigInt(quote.estimatedAmount), tokenOut.decimals),
      },
      fees: normalizeFees(quote.fees),
      ...(quote.correlationId ? { quoteReference: quote.correlationId } : {}),
    };
  }
}

export function createCircleStablecoinKitClient(options) {
  return new CircleStablecoinKitClient(options);
}

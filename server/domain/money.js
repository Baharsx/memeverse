import { formatUnits, parseUnits } from 'viem';
import { DomainError } from './errors.js';

const USDC_AMOUNT_PATTERN = /^\d+(?:\.\d{1,6})?$/;
export const USDC_DECIMALS = 6;

export function parseUsdc(value, field = 'amount') {
  if (typeof value !== 'string' || !USDC_AMOUNT_PATTERN.test(value)) {
    throw new DomainError(
      'INVALID_USDC_AMOUNT',
      `${field} must be a positive decimal string with at most 6 decimal places.`,
      { details: { field } },
    );
  }

  const units = parseUnits(value, USDC_DECIMALS);
  if (units <= 0n) {
    throw new DomainError('INVALID_USDC_AMOUNT', `${field} must be greater than zero.`, {
      details: { field },
    });
  }

  return units;
}

export function formatUsdc(units) {
  return formatUnits(BigInt(units), USDC_DECIMALS);
}

export function applyBasisPoints(units, basisPoints) {
  return (BigInt(units) * BigInt(basisPoints)) / 10000n;
}

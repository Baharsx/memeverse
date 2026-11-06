/**
 * Getting USDC onto Arc and choosing a buy amount.
 *
 * Mainnet sends people to Relay with Base USDC -> Arc USDC prefilled (the source chain can be
 * changed there). Testnet has no bridge for test funds, so it points at Circle's faucet instead.
 */
export const ARC_USDC = '0x3600000000000000000000000000000000000000';
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_CHAIN_ID = 8453;

export const RELAY_BRIDGE_TO_ARC_URL =
  `https://relay.link/bridge/arc?fromChainId=${BASE_CHAIN_ID}&fromCurrency=${BASE_USDC}&toCurrency=${ARC_USDC}`;
export const CIRCLE_TESTNET_FAUCET_URL = 'https://faucet.circle.com/';

export function fundingLink(isMainnet) {
  return isMainnet
    ? { href: RELAY_BRIDGE_TO_ARC_URL, label: 'GET USDC ON ARC', provider: 'Relay' }
    : { href: CIRCLE_TESTNET_FAUCET_URL, label: 'GET TEST USDC', provider: 'Circle faucet' };
}

/** Budgets offered as one-tap choices in the buy form, in whole USDC. */
export const QUICK_BUY_AMOUNTS = Object.freeze(['1', '5', '10', '25']);

/**
 * True only when the connected Arc wallet's USDC balance is known and cannot cover the budget.
 * An unknown balance (disconnected, wrong network, still loading) never triggers the prompt.
 */
export function needsMoreUsdc({ onArc, balance, budget }) {
  if (!onArc || typeof balance !== 'bigint' || typeof budget !== 'bigint') return false;
  return budget > 0n && balance < budget;
}

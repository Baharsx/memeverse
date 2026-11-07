import { formatUnits } from 'viem';

/**
 * One trade button for the whole onchain flow: an optional USDC allowance, the trade itself, and
 * the confirmations. Pure so every state can be tested without a wallet.
 */
const BUSY = new Set(['REQUESTED', 'WALLET_SIGNATURE', 'SUBMITTED']);

export function friendlyTradeError(message) {
  const text = String(message ?? '');
  if (/reject|denied|cancel/i.test(text)) return 'You cancelled the request in your wallet.';
  if (/insufficient funds|exceeds balance/i.test(text)) return 'Your wallet does not have enough USDC for this trade and its gas.';
  if (/slippage|minimum|too little received/i.test(text)) return 'The price moved before your trade landed. Check the new quote and try again.';
  if (/revert/i.test(text)) return 'The trade was not executed onchain. No funds left your wallet beyond gas.';
  return text ? text.slice(0, 140) : 'Something went wrong. Please try again.';
}

/**
 * @param side 'BUY' | 'SELL'
 * @param step null | 'approve' | 'trade' — which transaction the current click is on
 * @param needsApproval whether this buy first needs a USDC allowance
 */
export function tradeButtonState({ side, step, needsApproval, approval, action, ready, blockedLabel = null }) {
  const buying = side === 'BUY';
  const total = buying && (needsApproval || step === 'approve' || approval?.hash) ? 2 : 1;
  if (step === 'approve') {
    const signing = approval?.status !== 'SUBMITTED';
    return { busy: true, label: signing ? 'CONFIRM IN YOUR WALLET' : 'ALLOWING USDC…', progress: `Step 1 of 2 · ${signing ? 'Allow USDC for this buy' : 'Waiting for Arc'}` };
  }
  if (step === 'trade' || BUSY.has(action?.status)) {
    const signing = action?.status !== 'SUBMITTED';
    const verb = buying ? 'BUYING…' : 'SELLING…';
    const prefix = total === 2 ? 'Step 2 of 2 · ' : '';
    return { busy: true, label: signing ? 'CONFIRM IN YOUR WALLET' : verb, progress: `${prefix}${signing ? `Approve the ${buying ? 'buy' : 'sale'} in your wallet` : 'Waiting for Arc'}` };
  }
  if (blockedLabel) return { busy: false, label: blockedLabel, progress: null, disabled: true };
  const label = buying ? (needsApproval ? 'ALLOW USDC & BUY →' : 'BUY NOW →') : 'SELL NOW →';
  return { busy: false, label, progress: null, disabled: !ready };
}

/** The single line under the button: an error, a receipt, a pending hash, or a hint. */
export function tradeStatusLine({ side, step, needsApproval, approval, action }) {
  const failed = [action, approval].find((state) => state?.status === 'FAILED');
  if (failed && !step) return { tone: 'error', text: friendlyTradeError(failed.error), hash: failed.hash };
  const pending = step === 'approve' ? approval : step === 'trade' ? action : null;
  if (pending?.hash) return { tone: 'pending', text: 'Transaction sent.', hash: pending.hash };
  if (!step && action?.status === 'CONFIRMED') return { tone: 'done', text: side === 'BUY' ? 'Bought. Your position is updated.' : 'Sold. USDC is in your wallet.', hash: action.hash };
  if (!step && needsApproval) return { tone: 'hint', text: 'Two quick wallet confirmations: allow USDC, then buy.', hash: null };
  return null;
}

export const SELL_PRESETS = Object.freeze([
  ['25%', 1n, 4n],
  ['50%', 1n, 2n],
  ['MAX', 1n, 1n],
]);

/**
 * A sell amount for a fraction of the position, as an input string. Fractional (v2) markets sell
 * exact atomic units; whole-token (v1) markets round down to whole tokens.
 */
export function sellPresetAmount(balance, numerator, denominator, fractional) {
  if (typeof balance !== 'bigint' || balance <= 0n) return '';
  let units = (balance * numerator) / denominator;
  if (!fractional) units -= units % 10n ** 18n;
  if (units <= 0n) return '';
  return formatUnits(units, 18);
}

/** USDC kept back by MAX: gas on Arc is paid in USDC, enough for an allowance and a buy. */
export const GAS_RESERVE_USDC = 30_000n;

/** The MAX buy budget as an input string: the whole balance minus the gas reserve. */
export function maxBuyAmount(balance) {
  if (typeof balance !== 'bigint' || balance <= GAS_RESERVE_USDC) return '';
  return formatUnits(balance - GAS_RESERVE_USDC, 6);
}

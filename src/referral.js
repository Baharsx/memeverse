import { getAddress, isAddress } from 'viem';

/**
 * Referral attribution is an opt-in wallet signature, NOT a promise of rewards.
 * No key, balance, trading permission, or transaction is ever requested.
 */
export function referralAddress(value) {
  if (typeof value !== 'string' || !isAddress(value.trim())) return null;
  try {
    const address = getAddress(value.trim());
    return address === '0x0000000000000000000000000000000000000000' ? null : address;
  } catch {
    return null;
  }
}

export function referralMessage({ wallet, referrer, chainId, issuedAt }) {
  const a = referralAddress(wallet);
  const b = referralAddress(referrer);
  if (!a || !b || a.toLowerCase() === b.toLowerCase()) throw new Error('Invalid referral wallets.');
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid Arc chain.');
  const date = new Date(issuedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== issuedAt) throw new Error('Invalid signature time.');
  return [
    'MemeVerse Referral Attribution',
    'Domain: memeverse.biz',
    'Version: 1',
    'Chain ID: ' + chainId,
    'Referrer: ' + b,
    'New wallet: ' + a,
    'Issued at: ' + issuedAt,
    '',
    'I agree to link this wallet to the referrer for future eligibility review.',
    'No tokens are moved. No spending permission is granted. No reward is guaranteed.',
  ].join('\n');
}

export function referralShareUrl(wallet, siteOrigin, basePath = '/') {
  const address = referralAddress(wallet);
  if (!address) return null;
  const prefix = basePath === '/' ? '/' : '/' + basePath.replace(/^\/|\/$/g, '') + '/';
  const url = new URL(prefix + 'referral', siteOrigin);
  url.searchParams.set('ref', address);
  return url.toString();
}

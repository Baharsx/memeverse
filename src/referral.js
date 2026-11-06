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

export function referralCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{12}$/.test(value) ? value : null;
}

export function referralMessage({ wallet, referrer, code, chainId, issuedAt }) {
  const a = referralAddress(wallet);
  const b = referralAddress(referrer);
  const invite = referralCode(code);
  if (!a || (code !== undefined ? !invite : !b || a.toLowerCase() === b.toLowerCase())) throw new Error('Invalid referral authorization.');
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid Arc chain.');
  const date = new Date(issuedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== issuedAt) throw new Error('Invalid signature time.');
  return [
    'MemeVerse Referral Attribution',
    'Domain: memeverse.biz',
    invite ? 'Version: 2' : 'Version: 1',
    'Chain ID: ' + chainId,
    invite ? 'Invite code: ' + invite : 'Referrer: ' + b,
    'New wallet: ' + a,
    'Issued at: ' + issuedAt,
    '',
    'I agree to link this wallet to the referrer for future eligibility review.',
    'No tokens are moved. No spending permission is granted. No reward is guaranteed.',
  ].join('\n');
}

export function referralShareUrl(code, siteOrigin, basePath = '/') {
  const invite = referralCode(code);
  if (!invite) return null;
  const prefix = basePath === '/' ? '/' : '/' + basePath.replace(/^\/|\/$/g, '') + '/';
  const url = new URL(prefix + 'referral', siteOrigin);
  url.searchParams.set('ref', invite);
  return url.toString();
}

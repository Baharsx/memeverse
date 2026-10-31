import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recoverMessageAddress } from 'viem';
import { DomainError } from './errors.js';
import { referralAddress, referralMessage } from '../../src/referral.js';

export function createReferralService({ storageDir, chainId, clock = () => new Date() }) {
  const directory = join(storageDir, 'referrals');

  async function register({ wallet, referrer, issuedAt, signature }) {
    const address = referralAddress(wallet);
    const referredBy = referralAddress(referrer);
    if (!address || !referredBy || address.toLowerCase() === referredBy.toLowerCase()) {
      throw new DomainError('REFERRAL_INVALID', 'Provide two different, valid wallet addresses.', { status: 400 });
    }
    const timestamp = new Date(issuedAt);
    const age = clock().getTime() - timestamp.getTime();
    if (!Number.isFinite(age) || age < -60_000 || age > 5 * 60_000) {
      throw new DomainError('REFERRAL_EXPIRED', 'Referral signature expired. Sign again.', { status: 400 });
    }
    if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) {
      throw new DomainError('REFERRAL_SIGNATURE_INVALID', 'A valid wallet signature is required.', { status: 400 });
    }

    let message;
    try { message = referralMessage({ wallet: address, referrer: referredBy, chainId, issuedAt }); }
    catch { throw new DomainError('REFERRAL_INVALID', 'Invalid referral authorization.', { status: 400 }); }
    let signer;
    try { signer = await recoverMessageAddress({ message, signature }); }
    catch { throw new DomainError('REFERRAL_SIGNATURE_INVALID', 'Invalid wallet signature.', { status: 403 }); }
    if (signer.toLowerCase() !== address.toLowerCase()) {
      throw new DomainError('REFERRAL_NOT_WALLET', 'The connected wallet must sign its own referral.', { status: 403 });
    }

    const filename = join(directory, address.toLowerCase() + '.json');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const record = { wallet: address, referrer: referredBy, chainId, createdAt: clock().toISOString() };
    let file;
    try {
      // Exclusive create prevents a second referral from overwriting the first.
      file = await open(filename, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await readFile(filename, 'utf8'));
      if (existing.referrer.toLowerCase() !== referredBy.toLowerCase()) {
        throw new DomainError('REFERRAL_ALREADY_LINKED', 'This wallet already has a different referrer.', { status: 409 });
      }
      return { registered: true, existing: true, referrer: existing.referrer };
    }
    try { await file.writeFile(JSON.stringify(record) + '\n', 'utf8'); }
    finally { await file.close(); }
    return { registered: true, existing: false, referrer: referredBy };
  }

  return { register };
}

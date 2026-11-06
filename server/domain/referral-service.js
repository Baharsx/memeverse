import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { recoverMessageAddress } from 'viem';
import { DomainError } from './errors.js';
import { referralAddress, referralCode, referralMessage } from '../../src/referral.js';

export function createReferralService({ storageDir, chainId, clock = () => new Date() }) {
  const directory = join(storageDir, 'referrals');
  const invites = join(directory, 'invites');

  async function createInvite({ wallet }) {
    const address = referralAddress(wallet);
    if (!address) throw new DomainError('REFERRAL_INVALID', 'Provide a valid wallet address.', { status: 400 });
    await mkdir(invites, { recursive: true, mode: 0o700 });
    const walletFile = join(invites, `${chainId}-wallet-${address.toLowerCase()}.json`);
    try {
      const existing = JSON.parse(await readFile(walletFile, 'utf8'));
      return { code: existing.code, chainId };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomBytes(9).toString('base64url');
      const codeFile = join(invites, `${chainId}-code-${code}.json`);
      let file;
      try { file = await open(codeFile, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      try { await file.writeFile(JSON.stringify({ wallet: address, code, chainId }) + '\n'); }
      finally { await file.close(); }
      try {
        // Publish a fully written record atomically: concurrent requests share one stable code.
        await link(codeFile, walletFile);
        return { code, chainId };
      } catch (error) {
        await unlink(codeFile);
        if (error.code !== 'EEXIST') throw error;
        const existing = JSON.parse(await readFile(walletFile, 'utf8'));
        return { code: existing.code, chainId };
      }
    }
    throw new DomainError('REFERRAL_UNAVAILABLE', 'Could not create an invite. Try again.', { status: 503 });
  }

  async function register({ wallet, referrer, code, issuedAt, signature }) {
    const address = referralAddress(wallet);
    let referredBy = referralAddress(referrer);
    if (code !== undefined) {
      if (!referralCode(code)) throw new DomainError('REFERRAL_INVALID', 'Invalid invite code.', { status: 400 });
      try {
        const invite = JSON.parse(await readFile(join(invites, `${chainId}-code-${code}.json`), 'utf8'));
        if (invite.chainId !== chainId || invite.code !== code) throw new Error('Invalid stored invite');
        referredBy = referralAddress(invite.wallet);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        throw new DomainError('REFERRAL_INVALID', 'This invite is not available.', { status: 400 });
      }
    }
    if (!address || !referredBy || address.toLowerCase() === referredBy.toLowerCase()) {
      throw new DomainError('REFERRAL_INVALID', 'This wallet cannot register this invite.', { status: 400 });
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
    try { message = referralMessage({ wallet: address, referrer: referredBy, code, chainId, issuedAt }); }
    catch { throw new DomainError('REFERRAL_INVALID', 'Invalid referral authorization.', { status: 400 }); }
    let signer;
    try { signer = await recoverMessageAddress({ message, signature }); }
    catch { throw new DomainError('REFERRAL_SIGNATURE_INVALID', 'Invalid wallet signature.', { status: 403 }); }
    if (signer.toLowerCase() !== address.toLowerCase()) {
      throw new DomainError('REFERRAL_NOT_WALLET', 'The connected wallet must sign its own referral.', { status: 403 });
    }

    const filename = join(directory, address.toLowerCase() + '.json');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const record = { wallet: address, referrer: referredBy, code, chainId, createdAt: clock().toISOString() };
    let file;
    try {
      // Exclusive create prevents a second referral from overwriting the first.
      file = await open(filename, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await readFile(filename, 'utf8'));
      if (existing.chainId !== chainId || existing.referrer.toLowerCase() !== referredBy.toLowerCase()) {
        throw new DomainError('REFERRAL_ALREADY_LINKED', 'This wallet already has a different referrer.', { status: 409 });
      }
      return { registered: true, existing: true };
    }
    try { await file.writeFile(JSON.stringify(record) + '\n', 'utf8'); }
    finally { await file.close(); }
    return { registered: true, existing: false };
  }

  return { register, createInvite };
}

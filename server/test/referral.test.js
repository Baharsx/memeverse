import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createReferralService } from '../domain/referral-service.js';
import { referralAddress, referralMessage, referralShareUrl } from '../../src/referral.js';

test('wallet referral links are normalized and never trust arbitrary URL input', () => {
  const a = privateKeyToAccount(generatePrivateKey()).address;
  assert.equal(referralAddress('bad'), null);
  assert.equal(referralShareUrl(a, 'https://memeverse.biz'), 'https://memeverse.biz/referral?ref=' + a);
  assert.equal(referralShareUrl(a, 'https://memeverse.biz', '/memeverse/'), 'https://memeverse.biz/memeverse/referral?ref=' + a);
});

test('referral attribution needs fresh consent from the referred wallet and cannot be overwritten', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'memeverse-referral-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const user = privateKeyToAccount(generatePrivateKey());
  const referrer = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const now = new Date('2026-10-31T12:00:00.000Z');
  const service = createReferralService({ storageDir: folder, chainId: 5042, clock: () => now });
  const base = { wallet: user.address, referrer: referrer.address, chainId: 5042, issuedAt: now.toISOString() };
  const signature = await user.signMessage({ message: referralMessage(base) });
  const first = await service.register({ ...base, signature });
  assert.equal(first.existing, false);
  assert.equal((await service.register({ ...base, signature })).existing, true);
  await assert.rejects(
    service.register({ ...base, referrer: other.address, signature }),
    (error) => error.code === 'REFERRAL_NOT_WALLET',
  );
  const otherBase = { ...base, referrer: other.address };
  const otherSig = await user.signMessage({ message: referralMessage(otherBase) });
  await assert.rejects(
    service.register({ ...otherBase, signature: otherSig }),
    (error) => error.code === 'REFERRAL_ALREADY_LINKED',
  );
  await assert.rejects(
    service.register({ ...base, issuedAt: '2026-10-31T11:00:00.000Z', signature }),
    (error) => error.code === 'REFERRAL_EXPIRED',
  );
  await assert.rejects(
    service.register({ ...base, signature: await other.signMessage({ message: referralMessage(base) }) }),
    (error) => error.code === 'REFERRAL_NOT_WALLET',
  );
});

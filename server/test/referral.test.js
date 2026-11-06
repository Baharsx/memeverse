import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createReferralService } from '../domain/referral-service.js';
import { referralAddress, referralCode, referralMessage, referralShareUrl } from '../../src/referral.js';
import { startTestApp } from './helpers/app.js';
import { testAppOrigin } from './helpers/operator.js';

test('referral links contain short opaque codes and reject wallet-address URLs', () => {
  const a = privateKeyToAccount(generatePrivateKey()).address;
  assert.equal(referralAddress('bad'), null);
  assert.equal(referralShareUrl(a, 'https://memeverse.biz'), null);
  const code = 'aB3_kD9-zX2q';
  assert.equal(referralCode(code), code);
  assert.equal(referralCode('../file.json'), null);
  assert.equal(referralShareUrl(code, 'https://memeverse.biz'), 'https://memeverse.biz/referral?ref=' + code);
  assert.equal(referralShareUrl(code, 'https://memeverse.biz', '/memeverse/'), 'https://memeverse.biz/memeverse/referral?ref=' + code);
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

test('referral API requires same-site consent and validates a signed registration', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'memeverse-referral-http-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const member = privateKeyToAccount(generatePrivateKey());
  const inviter = privateKeyToAccount(generatePrivateKey());
  const referralService = createReferralService({ storageDir: folder, chainId: 5042 });
  const app = await startTestApp({ referralService, configOverrides: { arcChainId: 5042 } });
  t.after(() => app.close());
  const form = { wallet: member.address, referrer: inviter.address, issuedAt: new Date().toISOString() };
  const signature = await member.signMessage({ message: referralMessage({ ...form, chainId: 5042 }) });
  async function send(origin, payload) {
    return fetch(app.baseUrl + '/api/v1/referrals/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify(payload),
    });
  }
  assert.equal((await send(null, { ...form, signature })).status, 403);
  assert.equal((await send('https://unrelated.invalid', { ...form, signature })).status, 403);
  assert.equal((await send(testAppOrigin, { ...form, signature: '0xdead' })).status, 400);
  const ok = await send(testAppOrigin, { ...form, signature });
  assert.equal(ok.status, 201);
  const record = (await ok.json()).data;
  assert.equal(record.referrer, undefined);
  assert.equal(JSON.stringify(record).includes(inviter.address), false);
  assert.equal(JSON.stringify(record).includes(signature), false);
  const retry = await send(testAppOrigin, { ...form, signature });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).data.existing, true);
});

test('private invite codes persist, remain stable under concurrency and bind signed attribution', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'memeverse-private-invite-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const owner = privateKeyToAccount(generatePrivateKey());
  const member = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const service = createReferralService({ storageDir: folder, chainId: 5042 });
  const invites = await Promise.all(Array.from({ length: 8 }, () => service.createInvite({ wallet: owner.address })));
  const { code } = invites[0];
  assert.ok(referralCode(code));
  assert.ok(invites.every((invite) => invite.code === code));
  assert.equal(JSON.stringify(invites).includes(owner.address), false);
  const restarted = createReferralService({ storageDir: folder, chainId: 5042 });
  assert.equal((await restarted.createInvite({ wallet: owner.address.toLowerCase() })).code, code);
  const otherCode = (await service.createInvite({ wallet: other.address })).code;
  assert.notEqual(otherCode, code);
  const form = { wallet: member.address, code, chainId: 5042, issuedAt: new Date().toISOString() };
  const message = referralMessage(form);
  assert.equal(message.includes(owner.address), false);
  const signature = await member.signMessage({ message });
  await assert.rejects(service.register({ ...form, code: otherCode, signature }), (error) => error.code === 'REFERRAL_NOT_WALLET');
  assert.deepEqual(await service.register({ ...form, signature }), { registered: true, existing: false });
  assert.deepEqual(await restarted.register({ ...form, signature }), { registered: true, existing: true });
  await assert.rejects(service.register({ ...form, wallet: owner.address, signature }), (error) => error.code === 'REFERRAL_INVALID');
  const testnet = createReferralService({ storageDir: folder, chainId: 5042002 });
  await assert.rejects(testnet.register({ ...form, signature }), (error) => error.code === 'REFERRAL_INVALID');
});

test('invite API enforces origin and exposes neither a reverse lookup nor a wallet in its response', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'memeverse-invite-api-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const service = createReferralService({ storageDir: folder, chainId: 5042 });
  const app = await startTestApp({ referralService: service });
  t.after(() => app.close());
  const wallet = privateKeyToAccount(generatePrivateKey()).address;
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet }) };
  assert.equal((await fetch(app.baseUrl + '/api/v1/referrals/invite', options)).status, 403);
  const response = await fetch(app.baseUrl + '/api/v1/referrals/invite', { ...options, headers: { ...options.headers, origin: testAppOrigin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text();
  assert.equal(text.includes(wallet), false);
  const code = JSON.parse(text).data.code;
  assert.ok(referralCode(code));
  assert.equal((await fetch(app.baseUrl + '/api/v1/referrals/invite/' + code)).status, 404);
});

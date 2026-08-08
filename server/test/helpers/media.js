import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DomainError } from '../../domain/errors.js';
import { MediaService } from '../../domain/media-service.js';
import { MediaStore } from '../../infrastructure/media-store.js';
import {
  mediaAuthorizationExpiry,
  mediaAuthorizationMessage,
} from '../../../src/media-authorization.js';

// Published Hardhat development keys, exactly as the operator helper uses them: public knowledge,
// worthless on every network, and deterministic so signature assertions do not flake.
export const creatorAccount = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
export const strangerAccount = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);

export const testMarket = getAddress('0x1111111111111111111111111111111111111111');
export const unregisteredMarket = getAddress('0x2222222222222222222222222222222222222222');
export const testChainId = 5042002;

/**
 * A stub of the trusted Arc collector.
 *
 * It answers the same two questions the real `resolveMarket()` answers — is this market registered
 * in the trusted factory, and who does the contract say created it — so the tests exercise the
 * service's authorization logic without an RPC. Anything not explicitly registered here throws the
 * same MARKET_NOT_REGISTERED the real collector throws.
 */
export function stubCollector({ markets } = {}) {
  const registry = markets ?? new Map([[testMarket, creatorAccount.address]]);
  return {
    calls: [],
    async resolveMarket(address) {
      const normalized = getAddress(address);
      this.calls.push(normalized);
      const creator = registry.get(normalized);
      if (!creator) {
        throw new DomainError(
          'MARKET_NOT_REGISTERED',
          'The market is not registered in the trusted MemeVerse factory.',
          { status: 422 },
        );
      }
      return { marketAddress: normalized, creatorAddress: getAddress(creator), symbol: 'TEST' };
    },
  };
}

/**
 * A media service backed by a fresh temporary directory.
 *
 * Every test gets its own directory under the OS temp root and removes it afterwards, so a test
 * run can never read, write, or delete anything in a real deployment's media volume.
 */
export async function createTestMediaService({ collector = stubCollector() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-media-test-'));
  const store = new MediaStore({ directory, logger: { info() {}, error() {} } });
  const service = new MediaService({ store, collector, chainId: testChainId });
  return {
    service,
    store,
    collector,
    directory,
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A structurally valid PNG: signature, IHDR, one IDAT, IEND. */
export function pngFixture({ seed = 1 } = {}) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR', 'latin1'),
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    Buffer.from([0x1f, 0x15, 0xc4, 0x89]),
  ]);
  const idat = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x04]),
    Buffer.from('IDAT', 'latin1'),
    Buffer.from([seed & 0xff, 0x00, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
  ]);
  const iend = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('IEND', 'latin1'),
    Buffer.from([0xae, 0x42, 0x60, 0x82]),
  ]);
  return Buffer.concat([signature, ihdr, idat, iend]);
}

/** A JPEG with the SOI marker, a JFIF APP0 segment, and the EOI marker. */
export function jpegFixture({ seed = 1 } = {}) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from([0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([seed & 0xff, 0x00]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** A RIFF/WEBP container with a VP8 chunk and a correct declared size. */
export function webpFixture({ seed = 1 } = {}) {
  const payload = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    Buffer.from('VP8 ', 'latin1'),
    Buffer.from([0x08, 0x00, 0x00, 0x00]),
    Buffer.from([seed & 0xff, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, payload]);
}

export function gifFixture() {
  return Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]),
    Buffer.alloc(20, 0x11),
  ]);
}

export function svgFixture() {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    'utf8',
  );
}

export function htmlFixture() {
  return Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>', 'utf8');
}

/**
 * Builds a complete, correctly signed upload for a fixture, with any field overridable so a test
 * can corrupt exactly one thing and assert that it alone is rejected.
 */
export async function signedUpload({
  bytes = pngFixture(),
  declaredMimeType = 'image/png',
  action = 'MARKET_AVATAR',
  market = testMarket,
  account = creatorAccount,
  chainId = testChainId,
  expiresAt = mediaAuthorizationExpiry(),
  contentHash,
  signMessageAs,
} = {}) {
  const hash = contentHash ?? keccak256(bytes).toLowerCase();
  const message = mediaAuthorizationMessage({
    action: signMessageAs?.action ?? action,
    chainId: signMessageAs?.chainId ?? chainId,
    market: signMessageAs?.market ?? market,
    contentHash: signMessageAs?.contentHash ?? hash,
    expiresAt: signMessageAs?.expiresAt ?? expiresAt,
  });
  const signature = await account.signMessage({ message });
  return { bytes, declaredMimeType, action, market, contentHash: hash, expiresAt, signature };
}

/** Posts a prepared upload over HTTP exactly as the browser does. */
export function uploadRequest(baseUrl, upload, { origin = 'http://127.0.0.1:5173' } = {}) {
  const headers = {
    'content-type': upload.declaredMimeType,
    'x-memeverse-action': upload.action,
    'x-memeverse-market': upload.market,
    'x-memeverse-content-hash': upload.contentHash,
    'x-memeverse-expires-at': upload.expiresAt,
    'x-memeverse-signature': upload.signature,
  };
  if (origin) headers.origin = origin;
  return fetch(`${baseUrl}/api/v1/media/uploads`, {
    method: 'POST',
    headers,
    body: upload.bytes,
  });
}

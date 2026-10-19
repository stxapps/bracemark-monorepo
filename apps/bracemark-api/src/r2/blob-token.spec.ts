import { describe, expect, it } from 'vitest';

import { BlobTokenError, mintBlobToken, verifyBlobToken } from './blob-token';

// The blob route's credential (blob-token.ts). The route spec drives it end to
// end (routes/blob.spec.ts); what is pinned here is each way a token must be
// refused, because a token that verifies when it shouldn't is a read or a write
// of somebody's object, and nothing downstream would notice.
const SECRET = 'r2-secret-for-the-spec';
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const grant = { userId: 'u1', path: 'links/a.enc', method: 'PUT' as const, expiresIn: 300 };

async function refusal(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    if (err instanceof BlobTokenError) return err.code;
    throw err;
  }
  throw new Error('the token verified');
}

describe('blob tokens', () => {
  it('grant the user and path they were minted for', async () => {
    const token = await mintBlobToken(SECRET, grant, NOW);

    await expect(verifyBlobToken(SECRET, token, 'PUT', NOW + 1000)).resolves.toEqual({
      userId: 'u1',
      path: 'links/a.enc',
    });
  });

  // A GET token is good for an hour; if it could also write, an hour-long read
  // grant would be an hour-long write grant.
  it('grant one method only', async () => {
    const token = await mintBlobToken(SECRET, grant, NOW);

    expect(await refusal(verifyBlobToken(SECRET, token, 'GET', NOW))).toBe('blob_token_invalid');
  });

  it('expire at their expiry, not after', async () => {
    const token = await mintBlobToken(SECRET, grant, NOW);

    await expect(verifyBlobToken(SECRET, token, 'PUT', NOW + 299_000)).resolves.toBeTruthy();
    expect(await refusal(verifyBlobToken(SECRET, token, 'PUT', NOW + 300_000))).toBe(
      'blob_token_expired',
    );
  });

  // The payload is readable base64url JSON; the MAC is the only thing that makes
  // it a grant. Rewriting the user or the path must not survive it.
  it('refuse a payload edited to name another user', async () => {
    const [version, payload, mac] = (await mintBlobToken(SECRET, grant, NOW)).split('.');
    const body = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as object;
    const forged = btoa(JSON.stringify({ ...body, u: 'u2' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(await refusal(verifyBlobToken(SECRET, `${version}.${forged}.${mac}`, 'PUT', NOW))).toBe(
      'blob_token_invalid',
    );
  });

  // The key is derived from the env's R2 secret: another env's token, or one
  // from before a rotation, is not this env's.
  it('refuse a token signed under another secret', async () => {
    const token = await mintBlobToken('another-secret', grant, NOW);

    expect(await refusal(verifyBlobToken(SECRET, token, 'PUT', NOW))).toBe('blob_token_invalid');
  });

  it.each([
    ['empty', ''],
    ['one part', 'v1'],
    ['an unknown version', 'v2.e30.AAAA'],
    ['an extra part', 'v1.e30.AAAA.AAAA'],
    ['a mac that is not base64url', 'v1.e30.!!!!'],
    ['a session token', 'abc123def456'],
  ])('refuse a malformed token: %s', async (_name, token) => {
    expect(await refusal(verifyBlobToken(SECRET, token, 'PUT', NOW))).toBe('blob_token_invalid');
  });

  // Every path is contract-validated when it is signed. A token naming one the
  // contract refuses could only come from a bug elsewhere, and must not become
  // an R2 key outside the user's namespace.
  it('refuse a path the contract refuses, even under a valid mac', async () => {
    const token = await mintBlobToken(SECRET, { ...grant, path: '../u2/links/a.enc' }, NOW);

    expect(await refusal(verifyBlobToken(SECRET, token, 'PUT', NOW))).toBe('blob_token_invalid');
  });
});

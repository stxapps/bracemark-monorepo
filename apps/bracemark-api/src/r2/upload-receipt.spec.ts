import { describe, expect, it } from 'vitest';

import { commitOpSchema, MAX_RECEIPT_LENGTH } from '@stxapps/shared';

import { mintBlobToken } from './blob-token';
import { mintUploadReceipt, readUploadReceipt, RECEIPT_TTL_SECONDS } from './upload-receipt';

// The upload receipt (upload-receipt.ts). The route spec drives it end to end
// (routes/blob.spec.ts); what is pinned here is every way a receipt must read as
// NO receipt. One that read as valid when it shouldn't would let a commit record
// a put on facts R2 never reported — an op for an object that is not there, or a
// size the quota map was never told — and nothing downstream would notice.
const SECRET = 'r2-secret-for-the-spec';
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const owner = { userId: 'u1', path: 'links/a.enc' };
const stat = { updatedAt: NOW - 50, size: 343 };
const fence = { generation: 2, position: 41 };

const mint = (now = NOW) => mintUploadReceipt(SECRET, { ...owner, stat, fence }, now);

describe('upload receipts', () => {
  it('attest the facts and the fence they were minted with, to their owner and path', async () => {
    await expect(readUploadReceipt(SECRET, await mint(), owner, NOW + 1000)).resolves.toEqual({
      ...stat,
      fence,
    });
  });

  // The user and path are bound by the MAC, not carried: the commit supplies
  // both, so a receipt handed in under any other op reads as none.
  it('attest nothing for another user or another path', async () => {
    const receipt = await mint();

    await expect(readUploadReceipt(SECRET, receipt, { ...owner, userId: 'u2' }, NOW)).resolves.toBe(
      null,
    );
    await expect(
      readUploadReceipt(SECRET, receipt, { ...owner, path: 'links/b.enc' }, NOW),
    ).resolves.toBe(null);
  });

  it('attest nothing once expired', async () => {
    const receipt = await mint();
    const expiry = NOW + RECEIPT_TTL_SECONDS * 1000;

    await expect(readUploadReceipt(SECRET, receipt, owner, expiry - 1000)).resolves.not.toBe(null);
    await expect(readUploadReceipt(SECRET, receipt, owner, expiry)).resolves.toBe(null);
  });

  // The size is what the quota map records. A client that could lower it would
  // store more than its plan's ceiling lets it.
  it('attest nothing when the payload was changed', async () => {
    const [version, , mac] = (await mint()).split('.');
    const forged = btoa(JSON.stringify({ t: stat.updatedAt, s: 1, g: 2, q: 41, e: 9e9 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await expect(
      readUploadReceipt(SECRET, `${version}.${forged}.${mac}`, owner, NOW),
    ).resolves.toBe(null);
  });

  it('attest nothing under another key — a rotated secret, or a blob token', async () => {
    await expect(readUploadReceipt('another-secret', await mint(), owner, NOW)).resolves.toBe(null);

    const token = await mintBlobToken(
      SECRET,
      { ...owner, method: 'PUT', expiresIn: 300, fence },
      NOW,
    );
    await expect(readUploadReceipt(SECRET, token, owner, NOW)).resolves.toBe(null);
  });

  it('attest nothing when malformed', async () => {
    for (const receipt of [
      '',
      'v1',
      'v1..',
      'v2.e30.AAAA',
      'v1.e30.%%%',
      `${await mint()}.extra`,
    ]) {
      await expect(readUploadReceipt(SECRET, receipt, owner, NOW)).resolves.toBe(null);
    }
  });

  // The contract caps a receipt so a commit can't carry megabytes of them — and a
  // genuine receipt over that cap would 400 the whole batch, on every retry. Its
  // length must not grow with the path (unbounded in the contract) or any of
  // its integers.
  it('fit the commit contract at every extreme', async () => {
    const big = Number.MAX_SAFE_INTEGER;
    const receipt = await mintUploadReceipt(
      SECRET,
      {
        userId: 'u'.repeat(200),
        path: `links/${'x'.repeat(5000)}.enc`,
        stat: { updatedAt: big, size: big },
        fence: { generation: big, position: big },
      },
      NOW,
    );

    expect(receipt.length).toBeLessThan(MAX_RECEIPT_LENGTH / 2);
    expect(commitOpSchema.safeParse({ op: 'put', path: 'links/a.enc', receipt }).success).toBe(
      true,
    );
  });
});

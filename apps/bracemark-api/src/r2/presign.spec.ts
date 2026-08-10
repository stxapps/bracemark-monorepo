import { describe, expect, it } from 'vitest';

import { presignR2Url, type R2Credentials } from './presign';

// Unit coverage for the SigV4 presigner. The sync route tests run against the
// local `development` env, where files/sign returns dev blob-proxy URLs instead
// (routes/local-r2.ts) — so the real S3 presign branch is only exercised here, with
// explicit non-placeholder credentials and an injected clock for determinism.
describe('presignR2Url', () => {
  const creds: R2Credentials = {
    accountId: 'acct123',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secretkey',
    bucket: 'bracemark-user-files',
  };
  const now = new Date('2026-06-16T08:53:11.000Z');

  it('signs an R2 S3 endpoint URL with the canonical query params', async () => {
    const url = await presignR2Url(
      creds,
      { key: 'users/u1/links/a.enc', method: 'PUT', expiresIn: 300 },
      now,
    );
    const parsed = new URL(url);

    expect(parsed.origin).toBe('https://acct123.r2.cloudflarestorage.com');
    expect(parsed.pathname).toBe('/bracemark-user-files/users/u1/links/a.enc');
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsed.searchParams.get('X-Amz-Credential')).toBe(
      'AKIDEXAMPLE/20260616/auto/s3/aws4_request',
    );
    expect(parsed.searchParams.get('X-Amz-Date')).toBe('20260616T085311Z');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    // 64-hex-char HMAC-SHA256 signature.
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for a fixed clock and varies the signature by method', async () => {
    const opts = { key: 'users/u1/links/a.enc', expiresIn: 300 } as const;
    const put1 = await presignR2Url(creds, { ...opts, method: 'PUT' }, now);
    const put2 = await presignR2Url(creds, { ...opts, method: 'PUT' }, now);
    const get = await presignR2Url(creds, { ...opts, method: 'GET' }, now);

    const sig = (u: string) => new URL(u).searchParams.get('X-Amz-Signature');
    expect(sig(put1)).toBe(sig(put2));
    expect(sig(put1)).not.toBe(sig(get));
  });
});

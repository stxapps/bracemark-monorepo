// Presigned R2 URLs via AWS Signature V4 (query-string form). The R2 *binding*
// (env.USER_FILES) can read/write objects from inside the Worker, but it cannot
// mint a URL the BROWSER can PUT/GET directly — and direct browser↔R2 transfer is
// the whole point of the local-first data path (the blob bytes never touch the
// API; see docs/local-first-sync.md). So `files/sign` signs R2's S3-compatible
// endpoint with the account's R2 access keys, exactly as one would presign S3.
//
// Hand-rolled (no aws4fetch dep) and tiny: one object, UNSIGNED-PAYLOAD, the
// single `host` signed header. Uses only Web Crypto (HMAC/SHA-256), a global in
// workerd — no Node, no extra dependency to bundle. Credentials come from
// per-env config/secrets (see lib/env.ts R2_* + wrangler.jsonc).

import { bytesToHex, utf8 } from '@stxapps/shared';

export type R2Credentials = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export type PresignOptions = {
  key: string;
  method: 'PUT' | 'GET';
  // URL lifetime in seconds.
  expiresIn: number;
};

const ALGORITHM = 'AWS4-HMAC-SHA256';
const REGION = 'auto'; // R2 ignores region but SigV4 requires one; 'auto' is canonical.
const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

// RFC 3986 encode. encodeURIComponent leaves !'()* unescaped, which AWS requires
// escaped; `encodeKey` additionally keeps '/' literal so path separators survive.
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function encodeKey(key: string): string {
  return key.split('/').map(rfc3986).join('/');
}

async function sha256Hex(message: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(message))));
}

async function hmac(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, utf8(message));
}

// The SigV4 signing key: HMAC-chain the secret through date → region → service →
// 'aws4_request'. Derived per request (cheap) rather than cached.
async function signingKey(secret: string, datestamp: string): Promise<ArrayBuffer> {
  const kDate = await hmac(utf8(`AWS4${secret}`), datestamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

// `now` is injectable so tests are deterministic; defaults to the real clock.
export async function presignR2Url(
  creds: R2Credentials,
  { key, method, expiresIn }: PresignOptions,
  now: Date = new Date(),
): Promise<string> {
  const host = `${creds.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodeKey(creds.bucket)}/${encodeKey(key)}`;

  // amzDate: YYYYMMDDTHHMMSSZ; dateStamp: YYYYMMDD — straight off the ISO string.
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  // Query params that participate in the signature, sorted by key (canonical form).
  const query = new URLSearchParams();
  query.set('X-Amz-Algorithm', ALGORITHM);
  query.set('X-Amz-Credential', `${creds.accessKeyId}/${credentialScope}`);
  query.set('X-Amz-Date', amzDate);
  query.set('X-Amz-Expires', String(expiresIn));
  query.set('X-Amz-SignedHeaders', 'host');
  // URLSearchParams sorts and percent-encodes; sort() guarantees canonical order.
  query.sort();

  const canonicalRequest = [
    method,
    canonicalUri,
    query.toString(),
    `host:${host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = bytesToHex(
    new Uint8Array(await hmac(await signingKey(creds.secretAccessKey, dateStamp), stringToSign)),
  );

  return `https://${host}${canonicalUri}?${query.toString()}&X-Amz-Signature=${signature}`;
}

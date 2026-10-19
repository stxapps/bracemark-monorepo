// The credential of the blob route (routes/blob.ts) — this api's own presign.
// `files/sign` with `via: 'api'` mints one per path, and the client sends it back
// as `Authorization: Blob <token>` on the one transfer it authorizes. It is the
// same grant a SigV4 presign of R2 is (presign.ts): ONE object, ONE method, until
// an expiry, with no session behind it. That equivalence is the whole design, so
// the two are kept interchangeable rather than one being stronger:
//
//   - No database read. A token is checked with an HMAC and a clock, nothing
//     else. A session lookup is ~280 ms of D1 per request from the edge (the
//     `auth` Server-Timing metric), and a sync makes thousands of transfers.
//     Authorization was decided once, at `files/sign`, behind requireAuth and the
//     quota gate — exactly where a presign decides it.
//   - So a revoked session's tokens outlive it until they expire (5 min for a
//     PUT, an hour for a GET), as its presigned URLs always have.
//
// THE KEY IS DERIVED FROM R2_SECRET_ACCESS_KEY (HKDF, its own `info` label), not
// a secret of its own. A token grants what a presign signed with that secret
// grants, so they share a root: rotating the R2 key retires both together, and
// there is no second secret to provision per env, forget on a deploy, or keep
// in step with the first. HKDF keeps the two keys independent — neither one
// reveals the other, and an HMAC under one never verifies under the other. The
// `development` env's placeholder secret is committed (wrangler.jsonc), which is
// fine for the reason the dev blob proxy is (routes/local-r2.ts): the bucket it
// guards is miniflare's.
//
// Format: `v1.<payload>.<mac>`, both base64url; the payload is JSON. The MAC
// covers the version and the payload bytes as sent, so nothing is re-serialized
// before it is checked. The payload is readable — a user id and a path, both ids
// the server minted — and is not the secret part; the MAC is.

import { base64UrlToBytes, bytesToBase64Url, syncPathSchema, utf8 } from '@stxapps/shared';

export type BlobMethod = 'PUT' | 'GET';

// The authorization scheme on the header. Not `Bearer`: that one is a session,
// and requireAuth would read a blob token as an unknown session.
export const BLOB_AUTH_SCHEME = 'Blob';

const VERSION = 'v1';
const HKDF_INFO = 'bracemark-api blob token v1';

type Payload = {
  // user id — the R2 prefix the path resolves under (r2/keys.ts)
  u: string;
  // wire-relative path, already contract-validated when it was signed
  p: string;
  m: BlobMethod;
  // expiry, unix seconds
  e: number;
};

export type BlobGrant = { userId: string; path: string };

export class BlobTokenError extends Error {
  constructor(readonly code: 'blob_token_invalid' | 'blob_token_expired') {
    super(code);
    this.name = 'BlobTokenError';
  }
}

// One derived key per isolate per secret: an isolate serves thousands of
// transfers, and HKDF + importKey per request would be the only CPU a transfer
// spends. Keyed on the secret so a test env, or a rotated secret on a warm
// isolate, never reuses another's key.
let cached: { secret: string; key: Promise<CryptoKey> } | undefined;

function tokenKey(secret: string): Promise<CryptoKey> {
  if (cached?.secret !== secret) {
    const key = (async () => {
      const base = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(HKDF_INFO) },
        base,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign', 'verify'],
      );
    })();
    cached = { secret, key };
  }
  return cached.key;
}

function signedPart(payload: string): Uint8Array<ArrayBuffer> {
  return utf8(`${VERSION}.${payload}`);
}

// `now` is injectable so tests are deterministic; defaults to the real clock.
export async function mintBlobToken(
  secret: string,
  grant: BlobGrant & { method: BlobMethod; expiresIn: number },
  now: number = Date.now(),
): Promise<string> {
  const body: Payload = {
    u: grant.userId,
    p: grant.path,
    m: grant.method,
    e: Math.floor(now / 1000) + grant.expiresIn,
  };
  const payload = bytesToBase64Url(utf8(JSON.stringify(body)));
  const mac = await crypto.subtle.sign('HMAC', await tokenKey(secret), signedPart(payload));
  return `${VERSION}.${payload}.${bytesToBase64Url(new Uint8Array(mac))}`;
}

// The grant a token carries, or a BlobTokenError. `method` is the request's:
// a GET token cannot write and a PUT token cannot read, which is what keeps an
// hour-long read grant from being an hour-long write grant.
export async function verifyBlobToken(
  secret: string,
  token: string,
  method: BlobMethod,
  now: number = Date.now(),
): Promise<BlobGrant> {
  const [version, payload, mac, ...rest] = token.split('.');
  if (version !== VERSION || !payload || !mac || rest.length > 0) {
    throw new BlobTokenError('blob_token_invalid');
  }

  let macBytes: Uint8Array<ArrayBuffer>;
  try {
    macBytes = base64UrlToBytes(mac);
  } catch {
    throw new BlobTokenError('blob_token_invalid');
  }
  // subtle.verify compares in constant time; a string compare of two MACs would not.
  const valid = await crypto.subtle.verify(
    'HMAC',
    await tokenKey(secret),
    macBytes,
    signedPart(payload),
  );
  if (!valid) throw new BlobTokenError('blob_token_invalid');

  // Past the MAC the payload is ours, so a parse failure is a bug, not an
  // attack — still refused, never trusted half-read.
  let body: Payload;
  try {
    body = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as Payload;
  } catch {
    throw new BlobTokenError('blob_token_invalid');
  }
  if (body.m !== method || typeof body.u !== 'string' || body.u.length === 0) {
    throw new BlobTokenError('blob_token_invalid');
  }
  // The path was validated when it was signed; checked again so the key this
  // grant resolves to (r2/keys.ts) is never built from a shape the contract
  // refuses, whatever minted the token.
  if (!syncPathSchema.safeParse(body.p).success) throw new BlobTokenError('blob_token_invalid');
  if (typeof body.e !== 'number' || Math.floor(now / 1000) >= body.e) {
    throw new BlobTokenError('blob_token_expired');
  }
  return { userId: body.u, path: body.p };
}

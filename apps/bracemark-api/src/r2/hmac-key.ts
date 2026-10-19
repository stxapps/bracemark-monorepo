// The HMAC keys this api signs its own credentials with — the blob route's token
// (blob-token.ts) and the upload receipt (upload-receipt.ts) — each DERIVED from
// R2_SECRET_ACCESS_KEY under its own HKDF `info` label rather than provisioned as
// a secret of its own. blob-token.ts says why they share that root. HKDF keeps
// the keys independent: neither reveals another, and a MAC under one never
// verifies under another, so a token can never pass for a receipt or the reverse.

import { utf8 } from '@stxapps/shared';

// One derived key per isolate per (secret, label): an isolate serves thousands of
// transfers, and HKDF + importKey per request would be the only CPU a transfer
// spends. Keyed on the secret so a test env, or a rotated secret on a warm
// isolate, never reuses another's key.
const cached = new Map<string, { secret: string; key: Promise<CryptoKey> }>();

export function derivedHmacKey(secret: string, info: string): Promise<CryptoKey> {
  const hit = cached.get(info);
  if (hit?.secret === secret) return hit.key;
  const key = (async () => {
    const base = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) },
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify'],
    );
  })();
  cached.set(info, { secret, key });
  return key;
}

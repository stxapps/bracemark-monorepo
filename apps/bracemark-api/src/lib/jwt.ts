import { bytesToBase64Url, utf8 } from '@stxapps/shared';

// The JWT bits both store edges need — Workers-runtime, no Node Buffer. Shared
// by lib/appstore.ts (ES256, App Store Server API) and lib/playstore.ts (RS256,
// the Google service-account JWT-bearer flow): both mint a JWT signed with a
// PKCS#8 PEM secret, so only the alg and the claims differ. Lives here rather
// than in either provider file so neither store's vocab edge has to import the
// other's.
//
// The base64url alphabet itself is NOT here — that's a plain byte encoding, so
// it sits beside its hex/base64 siblings in `shared` (crypto/encoding.ts) and
// both this file and lib/ids.ts use it from there.

// A JWS header/claims segment: JSON → utf8 bytes → base64url. Kept here rather
// than in `shared` because the JSON-in-the-middle step is what makes it a JWT
// concern; `shared` owns only the byte encoding underneath it.
export function b64urlEncodeJson(value: unknown): string {
  return bytesToBase64Url(utf8(JSON.stringify(value)));
}

// PEM (PKCS#8) → raw DER bytes for crypto.subtle.importKey. Tolerates the
// header/footer and line breaks `wrangler secret put` preserves. Server-side
// secret loading, not a wire encoding — so this stays in bracemark-api, which is
// its only consumer. (Built over a plain ArrayBuffer explicitly — importKey's
// BufferSource rejects the ArrayBufferLike-typed view Uint8Array.from would
// produce.)
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----(BEGIN|END)[A-Z ]*KEY-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

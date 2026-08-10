// Byte encodings shared across every platform and the wire. Pure and
// platform-agnostic, so they live in `shared` (the lowest layer): the web crypto
// module, the future native client, and the server all need the same conversions
// and must agree on the exact form.
//
// - hex ⇄ bytes: how binary material (a wrapped DEK, a public key, a signature)
//   crosses a JSON request — lowercase, zero-padded, two chars per byte.
// - utf8: text → bytes for crypto inputs (signing payloads, HKDF/AEAD labels).

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// base64 ⇄ bytes: how binary that isn't crypto material (a preview image) crosses
// JSON — the extractor inlines image bytes as base64, clients decode them back.
// `atob`/`btoa` are referenced only inside the function bodies (like the hex pair),
// so merely importing `shared` never assumes those globals exist.
//
// Runtime requirement — native `atob`/`btoa` exist on Workers, browsers, and the
// extension, but Hermes (React Native/Expo) does NOT provide them: Hermes ships
// `TextEncoder` and Expo's winter runtime installs `TextDecoder`, but neither
// installs `atob`/`btoa`. So these two functions throw `ReferenceError` there
// unless the app installs a base64 polyfill at startup. Back that polyfill with a
// NATIVE base64 — on Expo, wire `btoa`/`atob` through `@craftzdog/react-native-buffer`'s
// Buffer (`Buffer.from(s, 'base64')` / `buf.toString('base64')`), which is C++-fast;
// prefer it over the pure-JS `base-64` lib, whose per-char loop janks the JS thread
// on the multi-hundred-KB images below. bracemark-expo does exactly this in its
// bootstrap `src/polyfills.ts` (imported first from the root `_layout.tsx`).
// We keep the native calls deliberately: they're C++-fast (these carry images) and
// battle-tested on base64's fiddly padding/tail cases, so the one-line app-level
// polyfill on the single deficient runtime beats hand-rolling base64 in JS for all
// four. The polyfill is an app-bootstrap concern, not a `shared` one — this layer
// stays pure and global-free by design.
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Chunked through String.fromCharCode so a multi-hundred-KB image doesn't blow the
// argument-spread stack limit.
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// base64url ⇄ bytes: the URL/header-safe alphabet (`+/` → `-_`, padding
// stripped), which is what anything travelling in a URL, an HTTP header, or a
// JWS compact serialization uses. Same `atob`/`btoa` runtime requirement as the
// plain-base64 pair above — including the Hermes caveat, already covered by the
// polyfill bracemark-expo installs.
//
// Today's callers are all bracemark-api (session tokens, and the App Store / Play
// Store JWTs in `lib/jwt.ts`), but the encoding itself is neither
// server-specific nor tied to our crypto contract — it's the same class of pure
// byte rendering as the hex and base64 pairs, so it lives beside them rather
// than being re-hand-rolled per call site. Note this is NOT part of the frozen
// key-derivation contract: nothing in crypto/contract-vectors.ts depends on it.
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Tolerates the missing tail padding that base64url conventionally strips.
export function base64UrlToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
}

// One encoder reused across calls: TextEncoder is stateless and `.encode()` is
// synchronous, so a singleton is safe and avoids per-call alloc. Created lazily
// on first use (not at module load) so merely importing `shared` never assumes a
// `TextEncoder` global — some test environments only define it once running.
let encoder: InstanceType<typeof TextEncoder> | undefined;

// Returns an ArrayBuffer-backed view (not SharedArrayBuffer) so the result is
// accepted directly as a Web Crypto `BufferSource`.
//
// Deliberately NOT the obvious `new Uint8Array(encode(s))`, which is a full byte
// COPY (that constructor copies a TypedArray source, it doesn't view it) on
// every call, including the multi-MB page-copy blobs the browser extension
// encodes. `TextEncoder.encode` is specified to allocate a fresh `Uint8Array`,
// so its buffer can never be a `SharedArrayBuffer`.
//
// This package type-checks under its OWN tsconfig (`lib: es2022` +
// `types: ["node"]`, NOT an app's `lib.dom`), so the return type comes from
// `@types/node`, which declares `encode(): NodeJS.NonSharedUint8Array`
// (= `Uint8Array<ArrayBuffer>`) — precise enough to satisfy the annotation
// above directly. Under `@types/node@20` it was a bare `Uint8Array`, and this
// needed an `as` assertion to compile; don't reintroduce one.
export const utf8 = (s: string): Uint8Array<ArrayBuffer> =>
  (encoder ??= new TextEncoder()).encode(s);

// The decode direction (entity payload bytes → JSON text), same lazy-singleton
// rationale as `utf8` above. Like `atob`, Hermes doesn't ship the global itself —
// on Expo it comes from the winter runtime's TextDecoder polyfill; providing the
// global is the app runtime's concern, `shared` stays global-free at import time.
let decoder: InstanceType<typeof TextDecoder> | undefined;

export const bytesToUtf8 = (bytes: Uint8Array): string =>
  (decoder ??= new TextDecoder()).decode(bytes);

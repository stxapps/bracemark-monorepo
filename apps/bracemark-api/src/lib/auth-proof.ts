import type { z } from 'zod';

import { hexToBytes, utf8 } from '@stxapps/shared';

import { HttpError } from './errors';

// Proof-of-possession for the auth flows. A client proves it holds the private
// key for the `publicKey` it presents by signing a JSON payload; we verify that
// signature over the EXACT bytes received, then check the payload is fresh and
// for the expected action. See "the load-bearing sign-in check" in
// docs/account.md.
//
// Ed25519 via Web Crypto — a global in the Workers runtime (no Node, no @noble
// dependency on the server), interoperable with the client's @noble/ed25519
// signatures (both are PureEdDSA over the raw message).

// How far the signed timestamp may drift from server time, each way. Bounds replay
// of a captured payload without demanding tight client-clock accuracy.
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

export async function verifyEd25519(
  publicKeyHex: string,
  message: string,
  signatureHex: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(publicKeyHex),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('Ed25519', key, hexToBytes(signatureHex), utf8(message));
}

// Validate + authenticate a signed auth payload. Returns the typed payload, or
// throws an HttpError (400/401) the global handler renders. The schema must yield a
// `publicKey` (verified against) and a `timestamp` (freshness-checked); the schema
// also enforces `action` (a z.literal), which binds the signature to one operation
// so a create-account proof can't be replayed as a sign-in.
export async function verifyAuthProof<T extends { publicKey: string; timestamp: number }>(
  rawPayload: string,
  signatureHex: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let json: unknown;
  try {
    json = JSON.parse(rawPayload);
  } catch {
    throw new HttpError(400, 'invalid_payload', 'Payload is not valid JSON');
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new HttpError(400, 'invalid_payload', 'Payload failed contract validation');
  }
  const payload = parsed.data;

  // Verify over the RAW string the client signed — not a re-serialization of the
  // parsed object, whose key order could differ and fail verification.
  const valid = await verifyEd25519(payload.publicKey, rawPayload, signatureHex);
  if (!valid) {
    throw new HttpError(401, 'invalid_signature', 'Signature does not match the public key');
  }

  if (Math.abs(Date.now() - payload.timestamp) > TIMESTAMP_WINDOW_MS) {
    throw new HttpError(401, 'stale_request', 'Request timestamp is outside the allowed window');
  }

  return payload;
}

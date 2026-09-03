import { afterEach, describe, expect, it, vi } from 'vitest';

import { bytesToHex, signInPayloadSchema } from '@stxapps/shared';

import { verifyAuthProof, verifyEd25519 } from './auth-proof';

// Proof-of-possession, in isolation. routes/auth.spec.ts drives the FLOWS this
// backs (sign-in, delete-account, change-password) and pins the two checks a
// flow can see — a signature that doesn't match the presented key, and an action
// replayed onto the wrong endpoint. What it can't reach from a route is what
// this file covers: the freshness window (no flow can move the clock) and the
// rule that verification runs over the RAW request bytes rather than a
// re-serialization of the parsed object. Both are silent when broken — a stale
// window still signs in, and a re-serializing verifier still passes for every
// client whose JSON happens to round-trip.

// A fixed server clock, so the ±5-minute window can be probed at its exact edge
// rather than approached from a safe distance.
const NOW = 1_760_000_000_000;
const WINDOW_MS = 5 * 60 * 1000;

async function newKeyPair(): Promise<{ keyPair: CryptoKeyPair; publicKey: string }> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return { keyPair, publicKey: bytesToHex(new Uint8Array(raw)) };
}

async function sign(keyPair: CryptoKeyPair, payload: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    'Ed25519',
    keyPair.privateKey,
    new TextEncoder().encode(payload),
  );
  return bytesToHex(new Uint8Array(sig));
}

describe('verifyAuthProof', () => {
  afterEach(() => vi.restoreAllMocks());

  function freezeClock(): void {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  }

  // The canonical happy payload: a real sign-in proof, signed over the exact
  // string handed to verifyAuthProof.
  async function proof(overrides: Record<string, unknown> = {}) {
    const { keyPair, publicKey } = await newKeyPair();
    const raw = JSON.stringify({
      action: 'sign-in',
      username: 'proofholder',
      publicKey,
      timestamp: NOW,
      ...overrides,
    });
    return { raw, signature: await sign(keyPair, raw), publicKey };
  }

  it('returns the typed payload for a fresh, correctly signed proof', async () => {
    freezeClock();
    const { raw, signature, publicKey } = await proof();

    await expect(verifyAuthProof(raw, signature, signInPayloadSchema)).resolves.toEqual({
      action: 'sign-in',
      username: 'proofholder',
      publicKey,
      timestamp: NOW,
    });
  });

  // The load-bearing one: the client signs a byte string, and zod's parse is
  // lossy against it — it strips unknown keys and knows nothing of whitespace.
  // A verifier that re-serialized `parsed.data` would reject this valid proof
  // (and, worse, accept bytes the client never signed).
  it('verifies over the RAW bytes, not a re-serialization of the parsed object', async () => {
    freezeClock();
    const { keyPair, publicKey } = await newKeyPair();
    // Pretty-printed, keys in an order zod's schema doesn't share, and carrying
    // a field the schema strips — none of which survives JSON.stringify(parsed).
    const raw = `{\n  "clientVersion": "1.4.0",\n  "timestamp": ${NOW},\n  "publicKey": "${publicKey}",\n  "username": "proofholder",\n  "action": "sign-in"\n}`;

    await expect(
      verifyAuthProof(raw, await sign(keyPair, raw), signInPayloadSchema),
    ).resolves.toMatchObject({ username: 'proofholder' });
  });

  it('rejects a signature made over different bytes (401 invalid_signature)', async () => {
    freezeClock();
    const { raw, signature } = await proof();
    // One character of the signed body changed after signing — the shape still
    // parses, so only the signature check can catch it.
    const tampered = raw.replace('proofholder', 'proofholdeR');

    await expect(verifyAuthProof(tampered, signature, signInPayloadSchema)).rejects.toMatchObject({
      status: 401,
      code: 'invalid_signature',
    });
  });

  it('rejects a payload older than the window (401 stale_request)', async () => {
    freezeClock();
    const { raw, signature } = await proof({ timestamp: NOW - WINDOW_MS - 1 });

    await expect(verifyAuthProof(raw, signature, signInPayloadSchema)).rejects.toMatchObject({
      status: 401,
      code: 'stale_request',
    });
  });

  // The window is symmetric on purpose: a client clock running FAST would
  // otherwise mint proofs that stay replayable long past the intended bound.
  it('rejects a payload dated too far in the future, not just too far in the past', async () => {
    freezeClock();
    const { raw, signature } = await proof({ timestamp: NOW + WINDOW_MS + 1 });

    await expect(verifyAuthProof(raw, signature, signInPayloadSchema)).rejects.toMatchObject({
      status: 401,
      code: 'stale_request',
    });
  });

  it('accepts a payload exactly at the window edge, each way', async () => {
    freezeClock();
    const past = await proof({ timestamp: NOW - WINDOW_MS });
    const future = await proof({ timestamp: NOW + WINDOW_MS });

    await expect(
      verifyAuthProof(past.raw, past.signature, signInPayloadSchema),
    ).resolves.toMatchObject({ timestamp: NOW - WINDOW_MS });
    await expect(
      verifyAuthProof(future.raw, future.signature, signInPayloadSchema),
    ).resolves.toMatchObject({ timestamp: NOW + WINDOW_MS });
  });

  // Both rejections are 400 (the request is malformed) and neither reveals
  // whether the signature was any good — the parse runs before the verify.
  it('rejects a body that is not JSON (400 invalid_payload)', async () => {
    const { keyPair } = await newKeyPair();
    const raw = 'not-json';

    await expect(
      verifyAuthProof(raw, await sign(keyPair, raw), signInPayloadSchema),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_payload' });
  });

  it('rejects a payload the schema cannot validate (400 invalid_payload)', async () => {
    freezeClock();
    const { keyPair, publicKey } = await newKeyPair();
    // No `timestamp` — so the freshness check has nothing to run on, and the
    // schema is the only thing standing between it and an unbounded replay.
    const raw = JSON.stringify({ action: 'sign-in', username: 'proofholder', publicKey });

    await expect(
      verifyAuthProof(raw, await sign(keyPair, raw), signInPayloadSchema),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_payload' });
  });
});

describe('verifyEd25519', () => {
  // The interop contract with the client's @noble/ed25519 signatures: both sides
  // are PureEdDSA over the raw utf8 message, hex on the wire.
  it('accepts a signature over the same message and rejects one over another', async () => {
    const { keyPair, publicKey } = await newKeyPair();
    const signature = await sign(keyPair, 'hello');

    await expect(verifyEd25519(publicKey, 'hello', signature)).resolves.toBe(true);
    await expect(verifyEd25519(publicKey, 'hell0', signature)).resolves.toBe(false);
  });

  it('rejects a signature from a different key', async () => {
    const mine = await newKeyPair();
    const theirs = await newKeyPair();

    await expect(
      verifyEd25519(mine.publicKey, 'hello', await sign(theirs.keyPair, 'hello')),
    ).resolves.toBe(false);
  });
});

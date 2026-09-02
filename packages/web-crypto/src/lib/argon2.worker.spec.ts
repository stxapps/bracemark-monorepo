/**
 * @jest-environment node
 *
 * The dedicated Argon2id worker — bracemark-web's default KDF path, and the one
 * piece of the account pipeline no other spec executes. contract-vectors.spec.ts
 * and the expo suite both derive on a main-thread runner, so without this file
 * the code that actually derives the KEK for every real web sign-in was never
 * run by a test.
 *
 * Two things are pinned here, and they fail in opposite directions:
 *   - the worker derives the SAME bytes as the main-thread path. A divergence
 *     (a dropped ARGON2_PARAMS spread, a stray `outputType`) means an account
 *     created in the extension can't be opened on the web app, and vice versa —
 *     permanent lockout, since there is no password reset (docs/account.md).
 *   - a THROWN Argon2id settles as `{ ok: false }`. The client's promise
 *     (argon2-worker-client.ts) only settles on a message or an `onerror`; an
 *     exception escaping this handler would leave a rejected promise inside the
 *     worker and a sign-in button spinning forever with nothing to report.
 *
 * The message SHAPE is the contract between this file and its client, and it is
 * unusually easy to break silently: the two halves communicate through
 * `postMessage`, so a renamed field is neither a type error nor a lint error.
 */
import { bytesToHex, CRYPTO_CONTRACT_VECTOR as V, deriveUserSalt } from '@stxapps/shared';

// Argon2id at the frozen params (64 MiB, t=3).
jest.setTimeout(120_000);

type WorkerResult = { ok: true; hash: Uint8Array } | { ok: false; error: string };

// The worker addresses its globals through `globalThis` (it can't pull in the
// WebWorker lib — see the file), which is exactly what lets this run under node.
const ctx = globalThis as unknown as {
  onmessage: ((event: { data: { password: string; salt: Uint8Array } }) => void) | null;
  postMessage: (message: unknown) => void;
};

// Post one message in and wait for the one that comes back out.
const roundTrip = async (data: { password: string; salt: Uint8Array }): Promise<WorkerResult> => {
  const posted = new Promise<WorkerResult>((resolve) => {
    ctx.postMessage = (message) => resolve(message as WorkerResult);
  });
  ctx.onmessage?.({ data });
  return posted;
};

beforeAll(async () => {
  // Importing the module IS the registration — it assigns ctx.onmessage at load.
  await import('./argon2.worker');
});

it('registers a message handler on load (a worker that never answers is invisible)', () => {
  expect(ctx.onmessage).toEqual(expect.any(Function));
});

it('derives the frozen contract KEK, byte-identical to the main-thread path', async () => {
  const result = await roundTrip({ password: V.password, salt: deriveUserSalt(V.username) });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(bytesToHex(result.hash)).toBe(V.kekHex);
});

it('reports a failed derivation as { ok: false } instead of throwing into the void', async () => {
  // An 8-byte minimum salt is Argon2's own rule, so a zero-length one makes
  // hash-wasm throw for real — no mock needed to reach the catch.
  const result = await roundTrip({ password: V.password, salt: new Uint8Array(0) });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  // The client rethrows this string as an Error, so it has to carry something.
  expect(result.error).not.toBe('');
});

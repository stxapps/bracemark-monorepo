import { argon2id } from 'hash-wasm';

import { ARGON2_PARAMS } from '@stxapps/shared';

// Dedicated worker. Argon2id is ~1–3s of synchronous CPU work, so it runs off
// the main thread to keep the UI responsive (the worker WASM can't freeze the
// page). The global is typed loosely (via `globalThis`, not `self`) to avoid
// pulling the conflicting WebWorker lib into a package that compiles against
// DOM.
//
// The per-user salt is computed upstream (derivePasswordKek → deriveUserSalt in
// @stxapps/shared) and arrives ready-to-use, so the worker stays a pure
// Argon2id step with no knowledge of how the salt is built.
const ctx = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ password: string; salt: Uint8Array }>) => void) | null;
  postMessage: (message: unknown) => void;
};

ctx.onmessage = async (event) => {
  try {
    const { password, salt } = event.data;
    const hash = await argon2id({
      password,
      salt,
      ...ARGON2_PARAMS,
      outputType: 'binary',
    });
    ctx.postMessage({ ok: true, hash });
  } catch (error) {
    ctx.postMessage({ ok: false, error: String(error) });
  }
};

import { ARGON2_PARAMS } from '@stxapps/shared';

// How deriveArgon2Hash runs its ~1–3s Argon2id compute.
//
// Default 'worker' runs it in a dedicated worker, off the main thread, so the UI stays
// responsive (bracemark-web). The browser extension flips this to 'main' at startup (see
// its popup entry): wxt's DEV server serves the module worker cross-origin (from
// http://localhost) to the chrome-extension:// popup, and a cross-origin module worker
// on an extension page hard-crashes the popup renderer. In a popup that does nothing
// else during sign-in, briefly blocking the main thread for the KDF is an acceptable
// trade to avoid that whole class of worker fragility.
//
// The worker path lives in a separate module (./argon2-worker-client) loaded via dynamic
// import only when this runner is 'worker', so 'main'-only consumers (the extension)
// never pull the worker code or its emitted worker chunk into their bundle.
type Argon2Runner = 'worker' | 'main';
let runner: Argon2Runner = 'worker';

export function setArgon2Runner(next: Argon2Runner): void {
  runner = next;
}

// Runs Argon2id(password, salt) and resolves the raw 32-byte hash. This is the thin,
// web-specific KDF step, kept purpose-agnostic: the caller (derivePasswordKek) imports
// the result as the password door's KEK, but this function only knows "password + salt →
// bytes". The per-user salt is computed by that caller (via `deriveUserSalt` in
// @stxapps/shared) and handed in ready-to-use, so this stays a dumb Argon2id step with no
// knowledge of how the salt is built — the future native client reuses the same salt and
// only swaps this Argon2id call.
export async function deriveArgon2Hash(password: string, salt: Uint8Array): Promise<Uint8Array> {
  if (runner === 'main') return deriveOnMainThread(password, salt);

  const { deriveInWorker } = await import('./argon2-worker-client');
  return deriveInWorker(password, salt);
}

// Main-thread path: the SAME Argon2id call the worker makes, run inline. hash-wasm is
// dynamically imported so it's pulled in only where this path is actually used — it
// stays out of bracemark-web's main bundle (which uses the worker path and gets hash-wasm
// via the separate worker chunk).
async function deriveOnMainThread(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const { argon2id } = await import('hash-wasm');
  return argon2id({ password, salt, ...ARGON2_PARAMS, outputType: 'binary' });
}

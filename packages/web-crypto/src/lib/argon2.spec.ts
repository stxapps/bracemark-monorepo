/**
 * @jest-environment node
 *
 * Which THREAD the ~1–3s Argon2id runs on. `setArgon2Runner` is exported from
 * the package barrel for exactly one caller — the browser extension's popup
 * entry — because a cross-origin module worker on a chrome-extension:// page
 * hard-crashes the popup renderer (see argon2.ts). So the switch is not a
 * preference: if 'main' ever stopped routing away from the worker module, the
 * extension's sign-in would go back to killing its own renderer, and nothing
 * about that failure would point here.
 *
 * What the runner picks between is pinned elsewhere, so this spec stays about
 * the routing alone: contract-vectors.spec.ts runs the whole account pipeline on
 * the 'main' runner against the golden KEK, and argon2.worker.spec.ts pins the
 * worker's own compute against that same KEK — together, "both paths derive the
 * same bytes".
 *
 * One thing this runner CANNOT reach: `deriveInWorker` itself. It resolves its
 * worker URL from `import.meta.url`, which babel-jest compiles to CJS and node
 * then rejects as a syntax error, so the module is mocked out here rather than
 * loaded. Its Worker plumbing is covered only by driving the app (docs/e2e.md).
 */
import { ARGON2_PARAMS, deriveUserSalt } from '@stxapps/shared';

const mockDeriveInWorker = jest.fn(async (_password: string, _salt: Uint8Array) =>
  new Uint8Array(ARGON2_PARAMS.hashLength).fill(0x77),
);

jest.mock('./argon2-worker-client', () => ({ deriveInWorker: mockDeriveInWorker }));

const salt = deriveUserSalt('alice_01');

// Each test takes a FRESH copy of the module: `runner` is module-level state, so
// a shared instance would let one test's setArgon2Runner leak into the next and
// quietly make the default-runner assertion meaningless.
const freshArgon2 = async () => {
  jest.resetModules();
  return import('./argon2');
};

beforeEach(() => mockDeriveInWorker.mockClear());

it('defaults to the WORKER, so bracemark-web never blocks its main thread on the KDF', async () => {
  const { deriveArgon2Hash } = await freshArgon2();

  const hash = await deriveArgon2Hash('correct horse battery staple', salt);

  expect(mockDeriveInWorker).toHaveBeenCalledWith('correct horse battery staple', salt);
  expect(hash).toEqual(new Uint8Array(ARGON2_PARAMS.hashLength).fill(0x77));
});

it('routes AWAY from the worker once the extension selects the main thread', async () => {
  const { deriveArgon2Hash, setArgon2Runner } = await freshArgon2();
  setArgon2Runner('main');

  const hash = await deriveArgon2Hash('correct horse battery staple', salt);

  expect(mockDeriveInWorker).not.toHaveBeenCalled();
  expect(hash).toHaveLength(ARGON2_PARAMS.hashLength);
});

it('holds the selection for every later call, not just the next one', async () => {
  // The extension sets this once at popup startup; sign-in, create-account and
  // change-password all derive later and must each stay off the worker.
  const { deriveArgon2Hash, setArgon2Runner } = await freshArgon2();
  setArgon2Runner('main');

  await deriveArgon2Hash('one', salt);
  await deriveArgon2Hash('two', salt);

  expect(mockDeriveInWorker).not.toHaveBeenCalled();
});

it('is reversible — selecting the worker again routes back to it', async () => {
  const { deriveArgon2Hash, setArgon2Runner } = await freshArgon2();
  setArgon2Runner('main');
  setArgon2Runner('worker');

  await deriveArgon2Hash('correct horse battery staple', salt);

  expect(mockDeriveInWorker).toHaveBeenCalledTimes(1);
});

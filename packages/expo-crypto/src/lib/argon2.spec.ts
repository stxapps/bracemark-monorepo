// The Argon2id step, native side. contract-vectors.spec.ts already pins the
// output bytes for the contract's ASCII password, which covers the param-name
// mapping (iterations → passes, memorySize → memory, hashLength → tagLength) —
// get one wrong and that suite fails. This file covers the two things it can't:
//
//   - NON-ASCII passwords. This is the one place web and native encode the
//     password differently: web hands hash-wasm a STRING and lets it encode,
//     expo encodes to UTF-8 here, explicitly. For the contract vector's
//     'correct horse battery staple' those agree trivially, so nothing anywhere
//     pins that they still agree for a password with a character outside ASCII —
//     and a mismatch there is a permanent lockout for exactly the users who
//     don't type in English (docs/account.md: there is no password reset).
//   - the callback-to-promise seam. quick-crypto's argon2 is callback-style; a
//     wrapper that forgets its reject doesn't throw, it HANGS, and the sign-in
//     button spins forever with nothing to report.
//
// quick-crypto is shimmed onto hash-wasm's argon2id under jest (see ../testing),
// so this proves our mapping and adapter, not the native library.
import { argon2id } from 'hash-wasm';

import { ARGON2_PARAMS, deriveUserSalt } from '@stxapps/shared';

// Argon2id at the frozen params (64 MiB, t=3) runs a few times here.
jest.setTimeout(120_000);

const mockArgon2 = jest.fn();

jest.mock('react-native-quick-crypto', () => {
  const actual = jest.requireActual('react-native-quick-crypto');
  return {
    ...actual,
    argon2: (...args: unknown[]) => (mockArgon2 as (...a: unknown[]) => void)(...args),
  };
});

const salt = deriveUserSalt('alice_01');

const freshArgon2 = async () => {
  jest.resetModules();
  mockArgon2.mockReset();
  const actual = jest.requireActual<typeof import('react-native-quick-crypto')>(
    'react-native-quick-crypto',
  );
  mockArgon2.mockImplementation((...args: unknown[]) =>
    (actual.argon2 as unknown as (...a: unknown[]) => void)(...args),
  );
  return import('./argon2');
};

it('resolves the full tag length the contract asks for', async () => {
  const { deriveArgon2Hash } = await freshArgon2();

  const hash = await deriveArgon2Hash('correct horse battery staple', salt);

  expect(hash).toBeInstanceOf(Uint8Array);
  expect(hash).toHaveLength(ARGON2_PARAMS.hashLength);
});

it('feeds the KDF the password’s UTF-8 bytes — the same ones web feeds it', async () => {
  // hash-wasm encodes a string password as UTF-8 internally, which is exactly
  // what web-crypto relies on, so deriving the same input both ways is a stand-in
  // for the web implementation this package can't import across the platform
  // boundary. A UTF-16 (or charCode) encoding here would diverge on this
  // password and agree on every ASCII one.
  const { deriveArgon2Hash } = await freshArgon2();
  const password = 'パスワード-🔐-café';

  const [ours, asWebEncodesIt] = await Promise.all([
    deriveArgon2Hash(password, salt),
    argon2id({ password, salt, ...ARGON2_PARAMS, outputType: 'binary' }),
  ]);

  expect(ours).toEqual(new Uint8Array(asWebEncodesIt));
});

it('rejects when the native KDF reports an error, instead of hanging', async () => {
  const { deriveArgon2Hash } = await freshArgon2();
  mockArgon2.mockImplementation((_algorithm: unknown, _params: unknown, callback: unknown) => {
    (callback as (err: Error) => void)(new Error('nitro module unavailable'));
  });

  await expect(deriveArgon2Hash('correct horse battery staple', salt)).rejects.toThrow(
    'nitro module unavailable',
  );
});

// The device-local app/list lock verifier — the sibling of web-crypto's
// lock-verifier.spec.ts, and deliberately the same assertions: the two files are
// meant to read as one, so a property that holds on web and not here is a bug
// even though verifiers are never synced and no byte contract binds them.
//
// What IS specific to this side is the shape of the KDF call: quick-crypto's
// pbkdf2 is CALLBACK-style, wrapped here in a promise. A callback adapter that
// forgets one of its exits doesn't throw — it hangs, and the unlock sheet spins
// forever with nothing to report. Both exits are pinned at the bottom.
//
// quick-crypto is shimmed onto node:crypto under jest (see ../testing).
import { pbkdf2 as nodePbkdf2 } from 'node:crypto';

import { createLockVerifier, verifyLockPassword } from './lock-verifier';

// PBKDF2-SHA256 at 600k iterations runs a dozen or so times in this suite.
jest.setTimeout(60_000);

// Real derivation by default (delegated to the shim's node pbkdf2); individual
// tests below swap in a callback that fails, to reach the reject paths.
const mockPbkdf2 = jest.fn();

jest.mock('react-native-quick-crypto', () => {
  const actual = jest.requireActual('react-native-quick-crypto');
  return {
    ...actual,
    pbkdf2: (...args: unknown[]) => (mockPbkdf2 as (...a: unknown[]) => void)(...args),
  };
});

beforeEach(() => {
  mockPbkdf2.mockReset();
  mockPbkdf2.mockImplementation((...args: unknown[]) =>
    (nodePbkdf2 as unknown as (...a: unknown[]) => void)(...args),
  );
});

const HEX = /^[0-9a-f]+$/;

describe('createLockVerifier', () => {
  it('stores a 16-byte salt and a 32-byte hash, both lowercase hex', async () => {
    const verifier = await createLockVerifier('open sesame');

    expect(verifier.salt).toMatch(HEX);
    expect(verifier.salt).toHaveLength(32);
    expect(verifier.hash).toMatch(HEX);
    expect(verifier.hash).toHaveLength(64);
  });

  it('never stores the password itself, in any form the row exposes', async () => {
    // The whole point of moving off the old client's reversibly-encrypted copy:
    // a verifier row read straight out of the local store yields nothing.
    const verifier = await createLockVerifier('open sesame');

    expect(verifier.salt + verifier.hash).not.toContain(
      Buffer.from('open sesame', 'utf8').toString('hex'),
    );
  });

  it('salts each verifier separately, so two locks with ONE password differ', async () => {
    // A shared salt would make every list locked with the same password share a
    // hash — visible in the store as "these are the same password", and crackable
    // once for all of them.
    const [a, b] = await Promise.all([
      createLockVerifier('open sesame'),
      createLockVerifier('open sesame'),
    ]);

    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    await expect(verifyLockPassword('open sesame', a)).resolves.toBe(true);
    await expect(verifyLockPassword('open sesame', b)).resolves.toBe(true);
  });
});

describe('verifyLockPassword', () => {
  it('accepts the password the verifier was created with', async () => {
    const verifier = await createLockVerifier('open sesame');
    await expect(verifyLockPassword('open sesame', verifier)).resolves.toBe(true);
  });

  it('rejects a wrong password, including a one-character miss', async () => {
    const verifier = await createLockVerifier('open sesame');

    await expect(verifyLockPassword('open sesamf', verifier)).resolves.toBe(false);
    await expect(verifyLockPassword('', verifier)).resolves.toBe(false);
  });

  it('rejects when the SALT is not the one the hash was derived under', async () => {
    // Rules out a check that ignores the salt (or reads it from the wrong field)
    // — which would make every verifier interchangeable.
    const verifier = await createLockVerifier('open sesame');
    const other = await createLockVerifier('open sesame');

    await expect(
      verifyLockPassword('open sesame', { salt: other.salt, hash: verifier.hash }),
    ).resolves.toBe(false);
  });

  it('returns false — never throws — on a corrupt or truncated stored hash', async () => {
    // This is the length guard ahead of the constant-time compare. A row can be
    // short (a partial write) or long (a format someone changed); the unlock
    // sheet must show "wrong password", not a crash.
    const verifier = await createLockVerifier('open sesame');

    await expect(
      verifyLockPassword('open sesame', { ...verifier, hash: verifier.hash.slice(0, 40) }),
    ).resolves.toBe(false);
    await expect(
      verifyLockPassword('open sesame', { ...verifier, hash: verifier.hash + 'ab' }),
    ).resolves.toBe(false);
    await expect(verifyLockPassword('open sesame', { ...verifier, hash: '' })).resolves.toBe(false);
  });

  it('handles a non-ASCII password by its utf8 bytes', async () => {
    // A charCode-per-character encoding would mangle anything outside the BMP
    // and could collide two visibly different passwords.
    const verifier = await createLockVerifier('パスワード-🔐');

    await expect(verifyLockPassword('パスワード-🔐', verifier)).resolves.toBe(true);
    await expect(verifyLockPassword('パスワード-🔒', verifier)).resolves.toBe(false);
  });

  it('is case- and whitespace-SENSITIVE (a lock password is not canonicalized)', async () => {
    // Deliberately unlike the account password, which is trimmed and NFC-folded
    // before the KEK (canonicalizePassword) because a lockout there is
    // permanent. A lock has an escape hatch — sign out, which wipes every lock —
    // so it keeps the bytes the user typed.
    const verifier = await createLockVerifier('Open Sesame');

    await expect(verifyLockPassword('open sesame', verifier)).resolves.toBe(false);
    await expect(verifyLockPassword(' Open Sesame ', verifier)).resolves.toBe(false);
  });
});

describe('the callback-to-promise seam', () => {
  // Neither exit is reachable through the public API on a healthy device, and
  // neither would ever throw: a missing `reject` here is an unlock sheet that
  // spins forever. That is the failure this pair exists to make loud.
  it('rejects when the native KDF reports an error', async () => {
    mockPbkdf2.mockImplementation((...args: unknown[]) => {
      (args[5] as (err: Error | null) => void)(new Error('nitro module unavailable'));
    });

    await expect(createLockVerifier('open sesame')).rejects.toThrow('nitro module unavailable');
  });

  it('rejects when the native KDF reports success but hands back no key', async () => {
    mockPbkdf2.mockImplementation((...args: unknown[]) => {
      (args[5] as (err: Error | null, derived?: Uint8Array) => void)(null, undefined);
    });

    await expect(createLockVerifier('open sesame')).rejects.toThrow('pbkdf2 returned no key');
  });
});

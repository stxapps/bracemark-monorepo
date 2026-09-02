/**
 * @jest-environment node
 *
 * The device-local app/list lock verifier. Unlike everything else in this
 * package there is NO cross-platform byte contract to pin (verifiers are never
 * synced and are wiped on sign-out — docs/locks.md), so what's left to get wrong
 * is the verifier's own shape: a per-verifier random salt, a check that
 * re-derives rather than compares a stored secret, and a mismatch that returns
 * `false` instead of throwing.
 *
 * The last one is the quiet one. `verifyLockPassword` is called from the unlock
 * UI, where a THROW is a crashed screen and `false` is "wrong password, try
 * again" — so a corrupt or truncated row in the local store has to take the
 * second path.
 *
 * Node env: the real Web Crypto lives at globalThis.crypto there.
 */
import { createLockVerifier, verifyLockPassword } from './lock-verifier';

// PBKDF2-SHA256 at 600k iterations runs a dozen or so times in this suite.
jest.setTimeout(60_000);

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
    // …and both still open with that one password.
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
    // screen must show "wrong password", not a crash.
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

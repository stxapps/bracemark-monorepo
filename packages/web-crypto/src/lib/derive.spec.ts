/**
 * @jest-environment node
 *
 * The account pipeline's PROPERTIES, as distinct from its bytes.
 * contract-vectors.spec.ts pins the frozen values (salt, KEK, DEK, public key,
 * signature) and covers create/unlock/recovery-unlock; this covers what a fixed
 * vector structurally can't:
 *
 *   - the DOOR ROTATIONS. `changePasswordDoor` is reachable from settings and
 *     from the forgot-password flow, and had no spec at all — yet it is the one
 *     function that can strand a user, because it writes a door the server then
 *     serves back forever.
 *   - "TIER-1" (docs/account.md): a rotation re-wraps the DEK and changes
 *     NOTHING derived from it. Every already-synced blob was encrypted under the
 *     old session's encryptionKey, so if a rotation quietly minted a fresh DEK
 *     the user would keep their account and lose their library — with no error
 *     anywhere, because the new keys are perfectly valid keys.
 *   - the door is proved, not asserted: you cannot rotate a door you can't open.
 *   - the DEK is RANDOM, not derived from the password.
 *
 * encryptionKey is a non-extractable CryptoKey, so "same key" can only be shown
 * by USE — encrypt under one account, decrypt under the other. That is also
 * exactly how the app depends on it.
 *
 * Node env: the real Web Crypto lives at globalThis.crypto there, and hash-wasm
 * runs inline via the 'main' Argon2 runner (no Workers in jest).
 */
import * as ed25519 from '@noble/ed25519';

import {
  CRYPTO_CONTRACT_VECTOR as V,
  DOOR_PASSWORD,
  DOOR_RECOVERY,
  generateRecoveryCode,
  hexToBytes,
  utf8,
} from '@stxapps/shared';

import { setArgon2Runner } from './argon2';
import { decryptEntity, encryptEntity } from './blob';
import {
  type Account,
  changePasswordDoor,
  createAccount,
  regenerateRecoveryDoor,
  unlockAccount,
  unlockAccountWithRecovery,
  WrongPasswordError,
  WrongRecoveryCodeError,
} from './derive';

// Argon2id at the frozen params (64 MiB, t=3) runs many times in this suite.
jest.setTimeout(300_000);

beforeAll(() => setArgon2Runner('main'));

const PASSWORD = V.password;
const NEW_PASSWORD = 'a completely different passphrase';

// The only way to compare two non-extractable encryption keys: round-trip a
// payload through the real entity framer, one account each side.
const sharesEncryptionKey = async (a: Account, b: Account): Promise<boolean> => {
  const data = utf8('{"id":"a1","title":"a link"}');
  try {
    const plaintext = await decryptEntity(
      b.encryptionKey,
      await encryptEntity(a.encryptionKey, data, 'links/a1.enc'),
      'links/a1.enc',
    );
    return new TextDecoder().decode(plaintext) === '{"id":"a1","title":"a link"}';
  } catch {
    return false;
  }
};

describe('createAccount', () => {
  it('roots the account in a RANDOM DEK, not in the password', async () => {
    // Two accounts, byte-identical inputs. If the DEK were derived from
    // (username, password) they would collapse onto one identity — every user
    // who picked the same password sharing keys, and the wrapped door blob
    // (served pre-auth to anyone who names a username) becoming a password
    // oracle anyone could check offline against a known plaintext.
    const [a, b] = await Promise.all([
      createAccount(V.username, PASSWORD),
      createAccount(V.username, PASSWORD),
    ]);

    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.passwordDoor.wrappedDek).not.toEqual(b.passwordDoor.wrappedDek);
    expect(await sharesEncryptionKey(a, b)).toBe(false);
  });

  it('tags each door with its own doorType', async () => {
    // The tag is what the caller persists as the `account_keys` row's kind, and
    // what dekWrapAad binds the ciphertext to — a swap here would write a row
    // that no unwrap path can ever open.
    const created = await createAccount(V.username, PASSWORD, {
      recoveryCode: V.recovery.code,
    });

    expect(created.passwordDoor.doorType).toBe(DOOR_PASSWORD);
    expect(created.recoveryDoor?.doorType).toBe(DOOR_RECOVERY);
  });

  it('omits the recovery door when no code is given (recovery is skippable)', async () => {
    const created = await createAccount(V.username, PASSWORD);
    expect(created.recoveryDoor).toBeUndefined();
    expect('recoveryDoor' in created).toBe(false);
  });

  it('mints a keypair whose signatures verify under its own publicKey', async () => {
    // The contract vector pins ONE seed's key and signature; this pins the
    // pairing itself, for a random DEK. If `sign` and `publicKey` ever came from
    // different halves of the pipeline, every authenticated request would fail
    // server-side with nothing client-side to point at.
    const account = await createAccount(V.username, PASSWORD);
    const signature = await account.sign('bracemark-request-body');

    await expect(
      ed25519.verifyAsync(
        hexToBytes(signature),
        utf8('bracemark-request-body'),
        hexToBytes(account.publicKey),
      ),
    ).resolves.toBe(true);
  });

  it('binds the password door to the USERNAME, via the salt', async () => {
    // deriveUserSalt folds the username in, so the same password under a
    // different handle derives a different KEK and cannot open the door. This is
    // what stops one user's password opening another's pre-auth door blob.
    const created = await createAccount(V.username, PASSWORD);

    await expect(
      unlockAccount('someone_else', PASSWORD, created.passwordDoor),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

describe('unlockAccount', () => {
  it('recovers the SAME encryption key, so an existing library still decrypts', async () => {
    const created = await createAccount(V.username, PASSWORD);
    const unlocked = await unlockAccount(V.username, PASSWORD, created.passwordDoor);

    expect(unlocked.publicKey).toBe(created.publicKey);
    expect(await sharesEncryptionKey(created, unlocked)).toBe(true);
  });

  it('reports a TAMPERED door as a wrong password, not as a raw crypto error', async () => {
    // Deliberately indistinguishable (see derive.ts): the UI has one message for
    // both, and a leaked "OperationError" would tell an attacker which of the two
    // they hit. Only the decrypt throw maps — a KDF failure must still surface raw.
    const created = await createAccount(V.username, PASSWORD);
    created.passwordDoor.wrappedDek[0] ^= 0x01;

    await expect(unlockAccount(V.username, PASSWORD, created.passwordDoor)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it('refuses a RECOVERY door presented as a password door', async () => {
    // What a swapped `account_keys` row must produce. Two independent things
    // stand in the way and either alone is enough here — the recovery KEK is not
    // the password KEK, and dekWrapAad binds each blob to its doorType — so this
    // pins the OUTCOME, not the mechanism. The AAD's own contribution is pinned
    // at the primitive, in aes.spec.ts's AAD binding.
    const created = await createAccount(V.username, PASSWORD, { recoveryCode: V.recovery.code });
    const recoveryDoor = created.recoveryDoor;
    if (!recoveryDoor) throw new Error('expected a recovery door');

    await expect(unlockAccount(V.username, PASSWORD, recoveryDoor)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });
});

describe('unlockAccountWithRecovery', () => {
  it('accepts a freshly GENERATED code in its displayed, grouped form', async () => {
    // generateRecoveryCode returns "A1B2C-D3E4F-…" and that is the string the
    // user is shown and types back. normalizeRecoveryCode has to strip the
    // grouping on both the wrap and the unwrap side — the contract vector only
    // ever exercises an already-normalized code.
    const code = generateRecoveryCode();
    expect(code).toContain('-'); // guard: the generator really groups

    const created = await createAccount(V.username, PASSWORD, { recoveryCode: code });
    const recoveryDoor = created.recoveryDoor;
    if (!recoveryDoor) throw new Error('expected a recovery door');

    const viaRecovery = await unlockAccountWithRecovery(code, recoveryDoor);
    expect(viaRecovery.publicKey).toBe(created.publicKey);

    // …and typed back without the cosmetic grouping, or in lower case.
    const retyped = await unlockAccountWithRecovery(
      code.replace(/-/g, '').toLowerCase(),
      recoveryDoor,
    );
    expect(retyped.publicKey).toBe(created.publicKey);
  });

  it('opens the same encryption key as the password door', async () => {
    const created = await createAccount(V.username, PASSWORD, { recoveryCode: V.recovery.code });
    const recoveryDoor = created.recoveryDoor;
    if (!recoveryDoor) throw new Error('expected a recovery door');

    const viaRecovery = await unlockAccountWithRecovery(V.recovery.code, recoveryDoor);
    expect(await sharesEncryptionKey(created, viaRecovery)).toBe(true);
  });
});

describe('changePasswordDoor', () => {
  it('replaces the door: the new password opens it, the old one no longer does', async () => {
    const created = await createAccount(V.username, PASSWORD);

    const { passwordDoor } = await changePasswordDoor(V.username, NEW_PASSWORD, {
      kind: 'password',
      username: V.username,
      password: PASSWORD,
      door: created.passwordDoor,
    });

    const unlocked = await unlockAccount(V.username, NEW_PASSWORD, passwordDoor);
    expect(unlocked.publicKey).toBe(created.publicKey);
    await expect(unlockAccount(V.username, PASSWORD, passwordDoor)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it('is TIER-1 — the DEK is unchanged, so the library and the live session survive', async () => {
    // The returned `account` exists so the caller can sign the change-password
    // proof without re-opening the DEK; it has to be the SAME credential, and
    // its encryptionKey has to still decrypt what the old one wrote.
    const created = await createAccount(V.username, PASSWORD);
    const alreadySynced = await encryptEntity(
      created.encryptionKey,
      utf8('an existing link'),
      'links/a1.enc',
    );

    const { account } = await changePasswordDoor(V.username, NEW_PASSWORD, {
      kind: 'password',
      username: V.username,
      password: PASSWORD,
      door: created.passwordDoor,
    });

    expect(account.publicKey).toBe(created.publicKey);
    const plaintext = await decryptEntity(account.encryptionKey, alreadySynced, 'links/a1.enc');
    expect(new TextDecoder().decode(plaintext)).toBe('an existing link');
  });

  it('leaves the RECOVERY door working (only the password row is rewritten)', async () => {
    const created = await createAccount(V.username, PASSWORD, { recoveryCode: V.recovery.code });
    const recoveryDoor = created.recoveryDoor;
    if (!recoveryDoor) throw new Error('expected a recovery door');

    await changePasswordDoor(V.username, NEW_PASSWORD, {
      kind: 'password',
      username: V.username,
      password: PASSWORD,
      door: created.passwordDoor,
    });

    const viaRecovery = await unlockAccountWithRecovery(V.recovery.code, recoveryDoor);
    expect(viaRecovery.publicKey).toBe(created.publicKey);
  });

  it('accepts a RECOVERY opener — the forgot-password path sets a new password', async () => {
    const created = await createAccount(V.username, PASSWORD, { recoveryCode: V.recovery.code });
    const recoveryDoor = created.recoveryDoor;
    if (!recoveryDoor) throw new Error('expected a recovery door');

    const { passwordDoor, account } = await changePasswordDoor(V.username, NEW_PASSWORD, {
      kind: 'recovery',
      recoveryCode: V.recovery.code,
      door: recoveryDoor,
    });

    expect(account.publicKey).toBe(created.publicKey);
    await expect(unlockAccount(V.username, NEW_PASSWORD, passwordDoor)).resolves.toEqual(
      expect.objectContaining({ publicKey: created.publicKey }),
    );
  });

  it('refuses to rotate a door the opener cannot open', async () => {
    // The rotation IS the authorization: without this, holding someone's fetched
    // door bytes would be enough to mint a door only you can open. The DEK is
    // never recovered, so nothing is re-wrapped.
    const created = await createAccount(V.username, PASSWORD);

    await expect(
      changePasswordDoor(V.username, NEW_PASSWORD, {
        kind: 'password',
        username: V.username,
        password: 'not the password',
        door: created.passwordDoor,
      }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

describe('regenerateRecoveryDoor', () => {
  it('adds a recovery door to an account created without one', async () => {
    // Recovery is skippable at signup, so "generate" and "regenerate" are the
    // same call — the first use has no existing recovery door to prove.
    const created = await createAccount(V.username, PASSWORD);
    expect(created.recoveryDoor).toBeUndefined();

    const code = generateRecoveryCode();
    const { recoveryDoor, account } = await regenerateRecoveryDoor(code, {
      kind: 'password',
      username: V.username,
      password: PASSWORD,
      door: created.passwordDoor,
    });

    expect(account.publicKey).toBe(created.publicKey);
    expect(recoveryDoor.doorType).toBe(DOOR_RECOVERY);
    await expect(unlockAccountWithRecovery(code, recoveryDoor)).resolves.toEqual(
      expect.objectContaining({ publicKey: created.publicKey }),
    );
  });

  it('accepts the OLD recovery code as the opener (rotating from the code itself)', async () => {
    const created = await createAccount(V.username, PASSWORD, { recoveryCode: V.recovery.code });
    const oldDoor = created.recoveryDoor;
    if (!oldDoor) throw new Error('expected a recovery door');

    const newCode = generateRecoveryCode();
    const { recoveryDoor } = await regenerateRecoveryDoor(newCode, {
      kind: 'recovery',
      recoveryCode: V.recovery.code,
      door: oldDoor,
    });

    await expect(unlockAccountWithRecovery(newCode, recoveryDoor)).resolves.toEqual(
      expect.objectContaining({ publicKey: created.publicKey }),
    );
    await expect(unlockAccountWithRecovery(V.recovery.code, recoveryDoor)).rejects.toBeInstanceOf(
      WrongRecoveryCodeError,
    );
  });

  it('leaves the PASSWORD door working (only the recovery row is rewritten)', async () => {
    const created = await createAccount(V.username, PASSWORD, { recoveryCode: V.recovery.code });

    await regenerateRecoveryDoor(generateRecoveryCode(), {
      kind: 'password',
      username: V.username,
      password: PASSWORD,
      door: created.passwordDoor,
    });

    const unlocked = await unlockAccount(V.username, PASSWORD, created.passwordDoor);
    expect(unlocked.publicKey).toBe(created.publicKey);
  });

  it('refuses to rotate a door the opener cannot open', async () => {
    const created = await createAccount(V.username, PASSWORD, { recoveryCode: V.recovery.code });
    const oldDoor = created.recoveryDoor;
    if (!oldDoor) throw new Error('expected a recovery door');

    await expect(
      regenerateRecoveryDoor(generateRecoveryCode(), {
        kind: 'recovery',
        recoveryCode: '00000000000000000000000000000000',
        door: oldDoor,
      }),
    ).rejects.toBeInstanceOf(WrongRecoveryCodeError);
  });
});

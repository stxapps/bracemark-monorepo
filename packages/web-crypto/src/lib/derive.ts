import * as ed25519 from '@noble/ed25519';

import {
  bytesToHex,
  canonicalizePassword,
  dekWrapAad,
  deriveUserSalt,
  DOOR_PASSWORD,
  DOOR_RECOVERY,
  type DoorType,
  HKDF_INFO_AUTH_SEED,
  HKDF_INFO_ENCRYPTION_KEY,
  HKDF_INFO_RECOVERY_KEK,
  normalizeRecoveryCode,
  utf8,
} from '@stxapps/shared';

import { decrypt, encrypt } from './aes';
import { deriveArgon2Hash } from './argon2';

export interface Account {
  // Ed25519 public key (hex) — the credential the server verifies us by, not an
  // identifier (the server mints its own stable userId). Safe to send.
  publicKey: string;
  // AES-256-GCM key, non-extractable: usable for encrypt/decrypt but its raw
  // bytes can't be read back out of JS, so XSS can use it but not exfiltrate it.
  encryptionKey: CryptoKey;
  // Signs a payload with the Ed25519 private key. The key is captured in this
  // closure and never leaves the module — callers get signatures, not the key.
  sign: (payload: string) => Promise<string>;
}

// One door's persisted record (an `account_keys` row): a wrapped copy of the DEK
// plus the IV, tagged by `doorType`. `wrappedDek` is the AES-256-GCM
// ciphertext+tag, `iv` its nonce; `doorType` selects which KEK unwraps it. The
// wrapped DEK is ciphertext, so it is safe to send and store (zero-knowledge —
// the server holds a locked box).
export interface Door {
  doorType: DoorType;
  wrappedDek: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
}

// create-account result: the live keys PLUS the wrapped doors to persist
// server-side. The password door is always present; the recovery door is present
// iff the caller supplied a recovery code (it's skippable — docs/account.md).
// (Sign-in returns a bare Account — the doors already exist.)
export interface NewAccount extends Account {
  passwordDoor: Door;
  recoveryDoor?: Door;
}

// A wrapped DEK as it arrives from the server (the `account_keys` row's bytes) —
// the shape every unwrap path takes. `doorType` isn't carried here because the
// caller always knows which door it fetched; the AAD is supplied by the unwrapper.
export interface WrappedDek {
  wrappedDek: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
}

// The credential miss from unlockAccount: the GCM tag failed, meaning a wrong
// password — or a tampered/swapped blob, deliberately indistinguishable. Typed so
// callers can map exactly this to "incorrect username or password" while letting
// every other failure (Argon2 worker OOM, worker chunk load) surface as the
// infrastructure error it is, not a phantom credential error.
export class WrongPasswordError extends Error {}

// The recovery-door analogue of WrongPasswordError: the GCM tag failed unwrapping
// the recovery door, i.e. a wrong/mistyped recovery code (or a swapped blob).
// Distinct type so the recovery sign-in / change-password paths can surface
// "invalid recovery code" without conflating it with a password miss.
export class WrongRecoveryCodeError extends Error {}

// How a caller proves it may re-wrap the DEK (change password, regenerate
// recovery): it presents an EXISTING door it can open. Either the current
// password (+ username for the salt) or the recovery code, together with that
// door's fetched bytes. A live session is deliberately NOT an opener — the DEK
// never persists in the session, so door management always re-proves a door
// (mirrors the fresh-password re-entry that delete-account already requires).
export type DoorOpener =
  | { kind: 'password'; username: string; password: string; door: WrappedDek }
  | { kind: 'recovery'; recoveryCode: string; door: WrappedDek };

// HKDF needs a salt; the DEK is already uniformly random, so an empty salt is the
// standard choice (RFC 5869 treats it as a string of zeros).
const HKDF_SALT = new Uint8Array(0);

async function hkdf(
  master: CryptoKey,
  info: string,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: utf8(info) },
    master,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

// The DEK is the real root of the account — 32 random bytes, never derived from
// anything. Both create-account (fresh DEK) and sign-in (DEK unwrapped from a
// door) funnel through here, so the derived keys are identical regardless of
// which door opened the DEK.
//
//   DEK --HKDF(auth-seed)------> Ed25519 keypair (publicKey + sign)
//       `--HKDF(encryption-key)-> AES-256-GCM key
//
// The DEK never leaves this module; only the public key / signatures cross the
// boundary.
async function deriveFromDek(dek: Uint8Array<ArrayBuffer>): Promise<Account> {
  const master = await crypto.subtle.importKey('raw', dek, 'HKDF', false, ['deriveBits']);

  const authSeed = await hkdf(master, HKDF_INFO_AUTH_SEED, 32);
  const encryptionKeyBytes = await hkdf(master, HKDF_INFO_ENCRYPTION_KEY, 32);

  const publicKeyBytes = await ed25519.getPublicKeyAsync(authSeed);

  const encryptionKey = await crypto.subtle.importKey(
    'raw',
    encryptionKeyBytes,
    { name: 'AES-GCM' },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  );

  return {
    publicKey: bytesToHex(publicKeyBytes),
    encryptionKey,
    sign: async (payload: string) => bytesToHex(await ed25519.signAsync(utf8(payload), authSeed)),
  };
}

// The password door's KEK: Argon2id(password, per-user salt). It wraps/unwraps
// the DEK and is bound to (username, password) because the salt folds the
// username in (deriveUserSalt). Memory-hard because the password is low-entropy.
// Expensive (~1–3s) — runs Argon2id in a worker; the salt is computed by
// @stxapps/shared so every platform produces byte-identical KEKs.
async function derivePasswordKek(username: string, password: string): Promise<CryptoKey> {
  const salt = deriveUserSalt(username);
  // Canonicalize (trim + NFC) so equivalent encodings of the same password derive
  // one KEK on every platform — the frozen contract (see canonicalizePassword).
  const kekBytes = await deriveArgon2Hash(canonicalizePassword(password), salt);
  // Copy into an ArrayBuffer-backed view so Web Crypto accepts it as key material.
  return crypto.subtle.importKey('raw', new Uint8Array(kekBytes), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

// The recovery door's KEK: HKDF over the NORMALIZED recovery code. The code is
// already high-entropy (CSPRNG ≥256 bits — generateRecoveryCode), so a cheap HKDF
// suffices; no Argon2id (that's only for the low-entropy password). Normalizing
// first means a code typed with its display grouping or Crockford confusables
// still derives the same KEK. Web Crypto HKDF, same machinery as deriveFromDek;
// the `info` label is frozen in @stxapps/shared.
async function deriveRecoveryKek(recoveryCode: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    'raw',
    utf8(normalizeRecoveryCode(recoveryCode)),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const kekBytes = await hkdf(ikm, HKDF_INFO_RECOVERY_KEK, 32);
  return crypto.subtle.importKey('raw', kekBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

// Wrap one copy of the DEK under a door's KEK → the `account_keys` row to persist.
// The AAD binds the ciphertext to its doorType (dekWrapAad), so a server can't
// pass one door's blob off as another's.
async function wrapDek(
  kek: CryptoKey,
  doorType: DoorType,
  dek: Uint8Array<ArrayBuffer>,
): Promise<Door> {
  const { iv, ciphertext } = await encrypt(kek, dek, dekWrapAad(doorType));
  return { doorType, wrappedDek: ciphertext, iv };
}

// AEAD-unwrap the DEK from whichever door the opener presents. A wrong secret
// yields a wrong KEK and the GCM tag fails — that IS the credential check, mapped
// to the door-specific error (nothing is compared server-side). Only the decrypt
// throw is a credential miss; a KDF/worker failure propagates raw.
async function openDek(opener: DoorOpener): Promise<Uint8Array<ArrayBuffer>> {
  if (opener.kind === 'password') {
    const kek = await derivePasswordKek(opener.username, opener.password);
    try {
      const dek = await decrypt(
        kek,
        { iv: opener.door.iv, ciphertext: opener.door.wrappedDek },
        dekWrapAad(DOOR_PASSWORD),
      );
      return new Uint8Array(dek);
    } catch {
      throw new WrongPasswordError('Incorrect username or password');
    }
  }
  const kek = await deriveRecoveryKek(opener.recoveryCode);
  try {
    const dek = await decrypt(
      kek,
      { iv: opener.door.iv, ciphertext: opener.door.wrappedDek },
      dekWrapAad(DOOR_RECOVERY),
    );
    return new Uint8Array(dek);
  } catch {
    throw new WrongRecoveryCodeError('Invalid recovery code');
  }
}

// create-account. The root of the account is a fresh RANDOM DEK, wrapped under
// the password door (always) and, if a recovery code is supplied, the recovery
// door too — both wrap the SAME DEK. The DEK then derives the keypair and
// encryption key:
//
//   DEK          = crypto.getRandomValues(32)            (the real root)
//   password-KEK = Argon2id(password, salt)              (off-thread, in a worker)
//   passwordDoor = AES-256-GCM(password-KEK, DEK, aad = doorType)
//   recoveryDoor = AES-256-GCM(recovery-KEK, DEK, aad = doorType)   [optional]
//   DEK --HKDF--> Ed25519 keypair (publicKey + sign) + AES-256-GCM key
//
// Returns the live keys plus the wrapped door(s) to persist server-side (the
// `account_keys` rows). The DEK and KEKs never leave this module — only the
// public key / signatures and the (ciphertext) wrapped DEKs cross the boundary.
// A later passkey door wraps another copy of the SAME DEK; doors are additive and
// never change what's derived here. Recovery is SKIPPABLE (docs/account.md), so
// the recovery door is opt-in via `opts.recoveryCode`.
export async function createAccount(
  username: string,
  password: string,
  opts?: { recoveryCode?: string },
): Promise<NewAccount> {
  const dek = crypto.getRandomValues(new Uint8Array(32));

  const passwordKek = await derivePasswordKek(username, password);
  const passwordDoor = await wrapDek(passwordKek, DOOR_PASSWORD, dek);

  let recoveryDoor: Door | undefined;
  if (opts?.recoveryCode !== undefined) {
    const recoveryKek = await deriveRecoveryKek(opts.recoveryCode);
    recoveryDoor = await wrapDek(recoveryKek, DOOR_RECOVERY, dek);
  }

  const account = await deriveFromDek(dek);

  return recoveryDoor ? { ...account, passwordDoor, recoveryDoor } : { ...account, passwordDoor };
}

// sign-in (password door). Re-derive the password-KEK and AEAD-unwrap the fetched
// password-door blob to recover the DEK, then derive the same keys as
// create-account. A wrong password fails on the GCM tag (WrongPasswordError) —
// that IS the password check; nothing is compared server-side. `door` is the
// `account_keys` row the server hands back (pre-auth) for this username.
export async function unlockAccount(
  username: string,
  password: string,
  door: WrappedDek,
): Promise<Account> {
  const dek = await openDek({ kind: 'password', username, password, door });
  return deriveFromDek(dek);
}

// sign-in via the RECOVERY door — the escape hatch when the password is lost. The
// recovery code unwraps the SAME DEK and derives the SAME keys (identical
// publicKey), so the resulting session is indistinguishable from a password
// sign-in. A wrong code fails as WrongRecoveryCodeError. The UI that uses this
// should land the user in set-a-new-password (changePasswordDoor), since the
// reason they're here is a forgotten password.
export async function unlockAccountWithRecovery(
  recoveryCode: string,
  door: WrappedDek,
): Promise<Account> {
  const dek = await openDek({ kind: 'recovery', recoveryCode, door });
  return deriveFromDek(dek);
}

// Change the password door: prove an existing door (current password OR recovery
// code) to recover the DEK, then re-wrap it under a NEW password-KEK. This is a
// TIER-1 door rotation (docs/account.md) — the DEK is unchanged, so the keypair,
// publicKey, encryptionKey, and any live session all stay valid; only the
// password-door `account_keys` row is replaced.
//
// Returns BOTH the new door to persist AND the derived `account` (same publicKey /
// keys as always), so the caller can sign the change-password proof with the
// DEK-derived key without opening the DEK a second time.
export async function changePasswordDoor(
  username: string,
  newPassword: string,
  opener: DoorOpener,
): Promise<{ passwordDoor: Door; account: Account }> {
  const dek = await openDek(opener);
  const kek = await derivePasswordKek(username, newPassword);
  const passwordDoor = await wrapDek(kek, DOOR_PASSWORD, dek);
  const account = await deriveFromDek(dek);
  return { passwordDoor, account };
}

// Generate/regenerate the recovery door: prove an existing door, re-wrap the DEK
// under a NEW recovery code's KEK. Same tier-1 rotation as above — data and
// derived keys untouched; only the recovery-door row is written/replaced. The
// caller mints `newRecoveryCode` with generateRecoveryCode() and shows it once.
// Returns the new door plus the derived `account` for signing the proof.
export async function regenerateRecoveryDoor(
  newRecoveryCode: string,
  opener: DoorOpener,
): Promise<{ recoveryDoor: Door; account: Account }> {
  const dek = await openDek(opener);
  const kek = await deriveRecoveryKek(newRecoveryCode);
  const recoveryDoor = await wrapDek(kek, DOOR_RECOVERY, dek);
  const account = await deriveFromDek(dek);
  return { recoveryDoor, account };
}

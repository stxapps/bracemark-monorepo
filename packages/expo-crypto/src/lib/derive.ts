import { hkdfSync, randomBytes } from 'react-native-quick-crypto';
import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';

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

// The Expo sibling of web-crypto's derive.ts: the SAME derivation pipeline
// (docs/account.md), same @noble/ed25519 library, same frozen parameters from
// @stxapps/shared — only the platform primitives differ (quick-crypto HKDF /
// AES-GCM instead of Web Crypto). The contract-vector spec pins both platforms
// to identical bytes.
//
// @noble/ed25519 hashes with SHA-512 internally; on web it finds
// crypto.subtle, but React Native has no Web Crypto, so wire the pure-JS
// sha512 once at module load (the library's documented RN setup). This also
// unlocks the sync sign/getPublicKey paths used below.
// (The cast bridges @noble/hashes v1's `Uint8Array<ArrayBufferLike>` return to
// ed25519 v3's `Uint8Array<ArrayBuffer>` slot — sha512 always allocates a
// plain ArrayBuffer.)
ed25519.hashes.sha512 = (message: Uint8Array) => sha512(message) as Uint8Array<ArrayBuffer>;

export interface Account {
  // Ed25519 public key (hex) — the credential the server verifies us by, not an
  // identifier (the server mints its own stable userId). Safe to send.
  publicKey: string;
  // Raw AES-256-GCM key bytes. Unlike web (a non-extractable CryptoKey), native
  // has no unreadable key handle — at-rest protection is expo-secure-store's
  // job (Keychain / Android Keystore); in memory the bytes live here and feed
  // aes.ts and the BracemarkFileCrypto native module.
  encryptionKey: Uint8Array;
  // Signs a payload with the Ed25519 private key. The key is captured in this
  // closure and never leaves the module — callers get signatures, not the key.
  sign: (payload: string) => Promise<string>;
}

// One door's persisted record (an `account_keys` row) — see web-crypto's Door.
export interface Door {
  doorType: DoorType;
  wrappedDek: Uint8Array;
  iv: Uint8Array;
}

// create-account result: the live keys PLUS the wrapped doors to send to the
// server. The password door is always present; the recovery door is present iff
// the caller supplied a recovery code (it's skippable — docs/account.md).
// (Sign-in returns a bare Account — the doors already exist.)
export interface NewAccount extends Account {
  passwordDoor: Door;
  recoveryDoor?: Door;
}

// A wrapped DEK as it arrives from the server (the `account_keys` row's bytes) —
// the shape every unwrap path takes. See web-crypto's WrappedDek.
export interface WrappedDek {
  wrappedDek: Uint8Array;
  iv: Uint8Array;
}

// How a caller proves it may re-wrap the DEK (change password, regenerate
// recovery): it presents an EXISTING door it can open — same contract as
// web-crypto's DoorOpener (see there: a live session is deliberately NOT an
// opener; door management always re-proves a door).
export type DoorOpener =
  | { kind: 'password'; username: string; password: string; door: WrappedDek }
  | { kind: 'recovery'; recoveryCode: string; door: WrappedDek };

// The credential miss from unlockAccount: the GCM tag failed, meaning a wrong
// password — or a tampered/swapped blob, deliberately indistinguishable. Same
// contract as web-crypto's WrongPasswordError.
export class WrongPasswordError extends Error {}

// The recovery-door analogue of WrongPasswordError: the GCM tag failed unwrapping
// the recovery door, i.e. a wrong/mistyped recovery code (or a swapped blob).
// Same contract as web-crypto's WrongRecoveryCodeError.
export class WrongRecoveryCodeError extends Error {}

// HKDF needs a salt; the DEK is already uniformly random, so an empty salt is the
// standard choice (RFC 5869 treats it as a string of zeros).
const HKDF_SALT = new Uint8Array(0);

function hkdf(master: Uint8Array, info: string, bytes: number): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', master, HKDF_SALT, utf8(info), bytes));
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
function deriveFromDek(dek: Uint8Array): Account {
  const authSeed = hkdf(dek, HKDF_INFO_AUTH_SEED, 32);
  const encryptionKey = hkdf(dek, HKDF_INFO_ENCRYPTION_KEY, 32);

  const publicKeyBytes = ed25519.getPublicKey(authSeed);

  return {
    publicKey: bytesToHex(publicKeyBytes),
    encryptionKey,
    sign: async (payload: string) => bytesToHex(ed25519.sign(utf8(payload), authSeed)),
  };
}

// The password door's KEK: Argon2id(password, per-user salt) — see web-crypto's
// derivePasswordKek. The salt is computed by @stxapps/shared so every platform
// produces byte-identical KEKs; the ~1–3s Argon2id runs native (argon2.ts).
// Canonicalize (trim + NFC) so equivalent encodings of the same password derive
// one KEK on every platform — the frozen contract (see canonicalizePassword).
async function derivePasswordKek(username: string, password: string): Promise<Uint8Array> {
  const salt = deriveUserSalt(username);
  return deriveArgon2Hash(canonicalizePassword(password), salt);
}

// The recovery door's KEK: HKDF over the NORMALIZED recovery code — see
// web-crypto's deriveRecoveryKek. The code is already high-entropy (CSPRNG ≥256
// bits — generateRecoveryCode), so a cheap HKDF suffices; no Argon2id (that's
// only for the low-entropy password). Normalizing first means a code typed with
// its display grouping or Crockford confusables still derives the same KEK.
function deriveRecoveryKek(recoveryCode: string): Uint8Array {
  return hkdf(utf8(normalizeRecoveryCode(recoveryCode)), HKDF_INFO_RECOVERY_KEK, 32);
}

// Wrap one copy of the DEK under a door's KEK → the `account_keys` row to
// persist. The AAD binds the ciphertext to its doorType (dekWrapAad), so a
// server can't pass one door's blob off as another's.
async function wrapDek(kek: Uint8Array, doorType: DoorType, dek: Uint8Array): Promise<Door> {
  const { iv, ciphertext } = await encrypt(kek, dek, dekWrapAad(doorType));
  return { doorType, wrappedDek: ciphertext, iv };
}

// create-account — the same flow as web-crypto's createAccount. The root of the
// account is a fresh RANDOM DEK, wrapped under the password door (always) and,
// if a recovery code is supplied, the recovery door too — both wrap the SAME
// DEK. Recovery is SKIPPABLE (docs/account.md), so the recovery door is opt-in
// via `opts.recoveryCode`.
//
//   DEK          = randomBytes(32)                        (the real root)
//   password-KEK = Argon2id(password, salt)               (native, off the JS thread)
//   passwordDoor = AES-256-GCM(password-KEK, DEK, aad = doorType)
//   recoveryDoor = AES-256-GCM(recovery-KEK, DEK, aad = doorType)   [optional]
//   DEK --HKDF--> Ed25519 keypair (publicKey + sign) + AES-256-GCM key
export async function createAccount(
  username: string,
  password: string,
  opts?: { recoveryCode?: string },
): Promise<NewAccount> {
  const dek = new Uint8Array(randomBytes(32));

  const passwordKek = await derivePasswordKek(username, password);
  const passwordDoor = await wrapDek(passwordKek, DOOR_PASSWORD, dek);

  let recoveryDoor: Door | undefined;
  if (opts?.recoveryCode !== undefined) {
    recoveryDoor = await wrapDek(deriveRecoveryKek(opts.recoveryCode), DOOR_RECOVERY, dek);
  }

  const account = deriveFromDek(dek);

  return recoveryDoor ? { ...account, passwordDoor, recoveryDoor } : { ...account, passwordDoor };
}

// AEAD-unwrap the DEK from whichever door the opener presents — web-crypto's
// openDek, verbatim in contract: a wrong secret yields a wrong KEK and the GCM
// tag fails; that IS the credential check, mapped to the door-specific error
// (nothing is compared server-side). Only the decrypt throw is a credential
// miss; a KDF failure propagates raw.
async function openDek(opener: DoorOpener): Promise<Uint8Array> {
  if (opener.kind === 'password') {
    const kek = await derivePasswordKek(opener.username, opener.password);
    try {
      return await decrypt(
        kek,
        { iv: opener.door.iv, ciphertext: opener.door.wrappedDek },
        dekWrapAad(DOOR_PASSWORD),
      );
    } catch {
      throw new WrongPasswordError('Incorrect username or password');
    }
  }
  const kek = deriveRecoveryKek(opener.recoveryCode);
  try {
    return await decrypt(
      kek,
      { iv: opener.door.iv, ciphertext: opener.door.wrappedDek },
      dekWrapAad(DOOR_RECOVERY),
    );
  } catch {
    throw new WrongRecoveryCodeError('Invalid recovery code');
  }
}

// sign-in — the same flow as web-crypto's unlockAccount: re-derive the
// password-KEK and AEAD-unwrap the fetched password-door blob to recover the
// DEK. A wrong password yields a wrong KEK and the GCM tag fails — that IS the
// password check; nothing is compared server-side.
export async function unlockAccount(
  username: string,
  password: string,
  door: WrappedDek,
): Promise<Account> {
  const dek = await openDek({ kind: 'password', username, password, door });
  return deriveFromDek(dek);
}

// sign-in via the RECOVERY door — the escape hatch when the password is lost.
// The recovery code unwraps the SAME DEK and derives the SAME keys (identical
// publicKey), so the resulting session is indistinguishable from a password
// sign-in. A wrong code fails as WrongRecoveryCodeError — same contract as
// web-crypto's unlockAccountWithRecovery.
export async function unlockAccountWithRecovery(
  recoveryCode: string,
  door: WrappedDek,
): Promise<Account> {
  const dek = await openDek({ kind: 'recovery', recoveryCode, door });
  return deriveFromDek(dek);
}

// Change the password door: prove an existing door (current password OR recovery
// code) to recover the DEK, then re-wrap it under a NEW password-KEK — the same
// TIER-1 door rotation as web-crypto's changePasswordDoor (see there: the DEK is
// unchanged, so the keypair, publicKey, encryptionKey, and any live session all
// stay valid; only the password-door `account_keys` row is replaced). Returns
// BOTH the new door to persist AND the derived `account`, so the caller can sign
// the change-password proof without opening the DEK a second time.
export async function changePasswordDoor(
  username: string,
  newPassword: string,
  opener: DoorOpener,
): Promise<{ passwordDoor: Door; account: Account }> {
  const dek = await openDek(opener);
  const kek = await derivePasswordKek(username, newPassword);
  const passwordDoor = await wrapDek(kek, DOOR_PASSWORD, dek);
  const account = deriveFromDek(dek);
  return { passwordDoor, account };
}

// Generate/regenerate the recovery door: prove an existing door, re-wrap the DEK
// under a NEW recovery code's KEK — web-crypto's regenerateRecoveryDoor, same
// tier-1 rotation as above. The caller mints `newRecoveryCode` with
// generateRecoveryCode() and shows it once. Returns the new door plus the
// derived `account` for signing the proof.
export async function regenerateRecoveryDoor(
  newRecoveryCode: string,
  opener: DoorOpener,
): Promise<{ recoveryDoor: Door; account: Account }> {
  const dek = await openDek(opener);
  const kek = deriveRecoveryKek(newRecoveryCode);
  const recoveryDoor = await wrapDek(kek, DOOR_RECOVERY, dek);
  const account = deriveFromDek(dek);
  return { recoveryDoor, account };
}

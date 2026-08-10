import { useMutation } from '@tanstack/react-query';

import { changePasswordDoor, type DoorOpener } from '@stxapps/expo-crypto';
import { useApiClient } from '@stxapps/react';
import {
  type ApiClient,
  ApiError,
  bytesToHex,
  changePasswordEndpoint,
  type ChangePasswordPayload,
  hexToBytes,
  passwordDoorEndpoint,
  recoveryDoorEndpoint,
} from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { InvalidCredentialsError } from './use-sign-in';
import { InvalidRecoveryCodeError } from './use-sign-in-with-recovery';

// The expo sibling of web-react's hooks/use-change-password.ts, verbatim in
// contract (see there for the full rationale): a TIER-1 door rotation — the DEK
// is unchanged, so the publicKey, encryptionKey, all data, and the current
// session stay valid; only the password door is re-wrapped. The caller proves an
// EXISTING door (current password or recovery code); a live session is
// deliberately NOT sufficient. Only the platform seams differ — expo-crypto's
// changePasswordDoor (native Argon2id) and this package's auth provider.

// How the caller proves it may re-wrap the DEK. The two cases the "Change
// password" UI exposes (docs/account.md): "I know my current password" and "I
// forgot it (but have my recovery code)".
export type DoorProofInput =
  { kind: 'password'; currentPassword: string } | { kind: 'recovery'; recoveryCode: string };

// Fetch the wrapped door the proof will open and assemble the expo-crypto
// DoorOpener. Shared by useChangePassword and useRecoveryCode — both re-wrap the
// DEK and so must first open it. A 404 on the door fetch (no account, or no
// recovery door) maps to the proof-kind's typed miss, the catch-all the forms map
// to a field error.
export async function openerForProof(
  api: ApiClient,
  username: string,
  proof: DoorProofInput,
): Promise<DoorOpener> {
  if (proof.kind === 'password') {
    let door;
    try {
      door = await api.call(passwordDoorEndpoint, { username });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw new InvalidCredentialsError();
      throw err;
    }
    return {
      kind: 'password',
      username,
      password: proof.currentPassword,
      door: { wrappedDek: hexToBytes(door.wrappedDek), iv: hexToBytes(door.iv) },
    };
  }

  let door;
  try {
    door = await api.call(recoveryDoorEndpoint, { username });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw new InvalidRecoveryCodeError();
    throw err;
  }
  return {
    kind: 'recovery',
    recoveryCode: proof.recoveryCode,
    door: { wrappedDek: hexToBytes(door.wrappedDek), iv: hexToBytes(door.iv) },
  };
}

// Map the expo-crypto open failures (wrong password / wrong recovery code) to the
// forms' typed misses; re-throw anything else (Argon2 failure, transport).
export function mapOpenError(err: unknown): never {
  // Both WrongPasswordError and WrongRecoveryCodeError are thrown from
  // @stxapps/expo-crypto; check by name to avoid importing both classes everywhere.
  if (err instanceof Error && err.name === 'WrongPasswordError')
    throw new InvalidCredentialsError();
  if (err instanceof Error && err.name === 'WrongRecoveryCodeError') {
    throw new InvalidRecoveryCodeError();
  }
  throw err;
}

export function useChangePassword() {
  const api = useApiClient();
  const { username } = useAuth();

  return useMutation({
    mutationFn: async ({ newPassword, proof }: { newPassword: string; proof: DoorProofInput }) => {
      if (!username) throw new Error('You must be signed in to change your password.');

      // Step 1: open the DEK via the presented door. (Both Argon2 runs — opening
      // the old password door and wrapping the new one — happen inside
      // changePasswordDoor; opening a recovery door is a cheap HKDF instead.)
      const opener = await openerForProof(api, username, proof);

      // Step 2: re-wrap the DEK under the new password's KEK. Returns the new door
      // to persist AND the (unchanged) account, so we sign the proof without
      // opening the DEK twice. A wrong current-password/recovery-code surfaces here
      // (mapOpenError → the form's typed miss).
      const { passwordDoor, account } = await changePasswordDoor(
        username,
        newPassword,
        opener,
      ).catch(mapOpenError);

      // Step 3: sign the action-bound proof (carrying the new door, so the
      // signature covers what gets stored) and POST it. The bearer token rides
      // along via authFetch; the server requires both.
      const payload = JSON.stringify({
        action: 'change-password',
        username,
        publicKey: account.publicKey,
        passwordDoor: {
          wrappedDek: bytesToHex(passwordDoor.wrappedDek),
          iv: bytesToHex(passwordDoor.iv),
        },
        timestamp: Date.now(),
      } satisfies ChangePasswordPayload);
      const signature = await account.sign(payload);

      try {
        await api.call(changePasswordEndpoint, { payload, signature });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) throw new InvalidCredentialsError();
        throw err;
      }
      // Nothing to persist locally: the DEK/publicKey/encryptionKey and the
      // session are all unchanged by a door rotation.
    },
  });
}

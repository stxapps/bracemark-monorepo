'use client';

import { useMutation } from '@tanstack/react-query';

import { useApiClient } from '@stxapps/react';
import {
  type ApiClient,
  ApiError,
  bytesToHex,
  changePasswordEndpoint,
  type ChangePasswordPayload,
  hexToBytes,
  readPasswordDoorEndpoint,
} from '@stxapps/shared';
import { changePasswordDoor, unlockAccount } from '@stxapps/web-crypto';

import { useAuth } from '../contexts/auth-provider';
import {
  type DoorProofInput,
  isNoAnswer,
  mapOpenError,
  openerForProof,
  UnconfirmedSaveError,
} from '../lib/door-proof';
import { InvalidCredentialsError } from './use-sign-in';

// Change the password door (Settings → Account → Change password). A TIER-1 door
// rotation: the DEK is unchanged, so the publicKey, encryptionKey, all data, and
// the current session stay valid — only the password door is re-wrapped. The
// caller proves an EXISTING door to recover the DEK: the current password (the
// common case) OR the recovery code (the "forgot my old password" case, e.g. just
// after a recovery sign-in). A live session is deliberately NOT sufficient — the
// server refuses this without a fresh proof signed by the DEK-derived key, so a
// stolen bearer token alone can't rotate a door. Web-only, same as use-sign-in.

// Whether `password` opens this account's password door as the server holds it NOW —
// `null` when the server can't be asked. This is how a change that got no answer is
// settled without asking the user to guess: the door either already takes the new
// password (it landed) or does not (nothing changed). It tells nobody anything new:
// the door is served pre-auth by design (docs/account.md, _why the wrapped DEK is
// served pre-auth_), so any password can be tested against it offline already.
async function opensNow(
  api: ApiClient,
  username: string,
  password: string,
): Promise<boolean | null> {
  let door;
  try {
    door = await api.call(readPasswordDoorEndpoint, { username });
  } catch {
    return null;
  }
  try {
    await unlockAccount(username, password, {
      wrappedDek: hexToBytes(door.wrappedDek),
      iv: hexToBytes(door.iv),
    });
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'WrongPasswordError') return false;
    throw err;
  }
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
      //
      // A refused CURRENT password may be a change that already landed: the save before
      // got no answer, and the retry proves with the old password, which the door no
      // longer takes. If the new password opens it, the account is already where this
      // call wants it, and that is success — not "Incorrect password." over a change
      // that worked, which is what sent people to type the new password as the current
      // one and meet "That's your current password."
      let rotated;
      try {
        rotated = await changePasswordDoor(username, newPassword, opener).catch(mapOpenError);
      } catch (err) {
        if (
          err instanceof InvalidCredentialsError &&
          proof.kind === 'password' &&
          (await opensNow(api, username, newPassword))
        ) {
          return;
        }
        throw err;
      }
      const { passwordDoor, account } = rotated;

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
        if (!isNoAnswer(err)) throw err;
        // No answer. Ask the door instead of the user: the new password opens it (the
        // save landed: done), or it does not (nothing changed: an ordinary failure, so
        // "try again" is true). Only a server that still can't be reached leaves it
        // unknown.
        const landed = await opensNow(api, username, newPassword);
        if (landed === true) return;
        if (landed === false) throw err;
        throw new UnconfirmedSaveError({ cause: err });
      }
      // Nothing to persist locally: the DEK/publicKey/encryptionKey and the
      // session are all unchanged by a door rotation.
    },
  });
}

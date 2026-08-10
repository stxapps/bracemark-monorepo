import { useMutation } from '@tanstack/react-query';

import { unlockAccount, WrongPasswordError } from '@stxapps/expo-crypto';
import { useApiClient } from '@stxapps/react';
import {
  ApiError,
  deleteAccountEndpoint,
  type DeleteAccountPayload,
  hexToBytes,
  passwordDoorEndpoint,
} from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { InvalidCredentialsError } from './use-sign-in';

// The expo sibling of web-react's hooks/use-delete-account.ts, verbatim in
// contract (see there): the same door-fetch → unwrap → sign shape as
// use-sign-in, bound to the `delete-account` action and finishing with the
// LOCAL teardown. The password re-entry is the point — the server refuses this
// call without a fresh proof signed by the DEK-derived key, so a stolen bearer
// token alone can never erase an account (docs/data-lifecycle.md).

// The server's 409: a subscription that would keep billing (renewing, or in
// dunning). Typed so the form can point the user at the Subscription section
// rather than showing a generic failure.
export class SubscriptionActiveError extends Error {}

export function useDeleteAccount() {
  const api = useApiClient();
  const { username, endSession } = useAuth();

  return useMutation({
    mutationFn: async ({ password }: { password: string }) => {
      // The session record stores the canonical username (use-sign-in
      // canonicalizes at the boundary), so it feeds the KDF salt and the signed
      // payload as-is.
      if (!username) throw new Error('You must be signed in to delete your account.');

      // Step 1: fetch this account's password-door blob — same pre-auth read as
      // sign-in; the client can't derive anything without it. A 404 while signed
      // in means the account is already gone (a torn-down retry, a tombstone) —
      // surface it as the credential error, the form's catch-all.
      let door;
      try {
        door = await api.call(passwordDoorEndpoint, { username });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) throw new InvalidCredentialsError();
        throw err;
      }

      // Step 2: re-derive the password-KEK and unwrap the DEK — the password
      // check happens HERE, on the GCM tag, exactly as at sign-in. Only the
      // typed miss maps to the credential error; an Argon2 infrastructure
      // failure surfaces as itself.
      let account;
      try {
        account = await unlockAccount(username, password, {
          wrappedDek: hexToBytes(door.wrappedDek),
          iv: hexToBytes(door.iv),
        });
      } catch (err) {
        if (err instanceof WrongPasswordError) throw new InvalidCredentialsError();
        throw err;
      }

      // Step 3: sign the action-bound proof and POST it. The bearer token rides
      // along via authFetch — the server requires BOTH (the session names the
      // account, the proof proves the key). Sign and send the EXACT same JSON
      // string the server verifies against — stringify once.
      const payload = JSON.stringify({
        action: 'delete-account',
        username,
        publicKey: account.publicKey,
        timestamp: Date.now(),
      } satisfies DeleteAccountPayload);
      const signature = await account.sign(payload);

      try {
        await api.call(deleteAccountEndpoint, { payload, signature });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) throw new SubscriptionActiveError();
        // 401 = the key didn't match the stored credential (or a stale proof).
        // With a correct password this is unreachable; treat it as a credential
        // miss rather than a generic failure.
        if (err instanceof ApiError && err.status === 401) throw new InvalidCredentialsError();
        throw err;
      }
    },
    // The server tore everything down (including every session); drop the local
    // session + all local data. Hook-level (not the component's continuation) so
    // a success that lands after navigation isn't lost — same reasoning as
    // use-sign-in. The default 'signed-out' reason sends the user home ('/'),
    // not to /sign-in?next=.
    onSuccess: async () => {
      await endSession();
    },
  });
}

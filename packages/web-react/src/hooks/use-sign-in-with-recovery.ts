'use client';

import { useMutation } from '@tanstack/react-query';

import { useApiClient } from '@stxapps/react';
import {
  ApiError,
  canonicalizeUsername,
  hexToBytes,
  recoveryDoorEndpoint,
  signInEndpoint,
  type SignInPayload,
} from '@stxapps/shared';
import { unlockAccountWithRecovery, WrongRecoveryCodeError } from '@stxapps/web-crypto';

import { useAuth } from '../contexts/auth-provider';

// Sign in with a RECOVERY CODE — the escape hatch when the password is lost. Same
// door-fetch → unwrap → sign shape as use-sign-in, but the recovery door (a cheap
// HKDF, not Argon2id) is what unwraps the DEK. The recovery code unwraps the SAME
// DEK and derives the SAME keypair, so the resulting session is identical to a
// password sign-in. The UI that uses this should route the user straight into
// set-a-new-password (useChangePassword) afterwards — the reason they're here is a
// forgotten password. Web-only for the same reason as use-sign-in.

// A single typed miss for every recovery-level failure — no such account/door, or
// a wrong code — kept indistinguishable (and distinct from the password miss so
// the "forgot password" UI can say "check your recovery code").
export class InvalidRecoveryCodeError extends Error {}

export function useSignInWithRecovery() {
  const api = useApiClient();
  const { setSession } = useAuth();

  return useMutation({
    mutationFn: async (values: { username: string; recoveryCode: string }) => {
      const username = canonicalizeUsername(values.username);

      // Step 1: fetch the RECOVERY-door blob (pre-auth). A 404 means no such
      // account, or an account that never set up recovery — surface both as the
      // same generic recovery miss so this isn't an enumeration oracle.
      let door;
      try {
        door = await api.call(recoveryDoorEndpoint, { username });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) throw new InvalidRecoveryCodeError();
        throw err;
      }

      // Step 2: HKDF the recovery-KEK over the normalized code and unwrap the DEK,
      // then derive the same keys a password sign-in would. A wrong code fails on
      // the GCM tag (WrongRecoveryCodeError) — that IS the check.
      let account;
      try {
        account = await unlockAccountWithRecovery(values.recoveryCode, {
          wrappedDek: hexToBytes(door.wrappedDek),
          iv: hexToBytes(door.iv),
        });
      } catch (err) {
        if (err instanceof WrongRecoveryCodeError) throw new InvalidRecoveryCodeError();
        throw err;
      }

      // Step 3: prove possession of the DEK-derived key and exchange for a session —
      // identical to a password sign-in from here (same publicKey, same 'sign-in'
      // action). Sign and send the EXACT JSON string the server verifies against.
      const payload = JSON.stringify({
        action: 'sign-in',
        username,
        publicKey: account.publicKey,
        timestamp: Date.now(),
      } satisfies SignInPayload);
      const signature = await account.sign(payload);

      let session;
      try {
        session = await api.call(signInEndpoint, { payload, signature });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) throw new InvalidRecoveryCodeError();
        throw err;
      }

      return { session, encryptionKey: account.encryptionKey, username };
    },
    onSuccess: async ({ session, encryptionKey, username }) => {
      await setSession({
        username,
        token: session.token,
        expiresAt: session.expiresAt,
        encryptionKey,
      });
    },
  });
}

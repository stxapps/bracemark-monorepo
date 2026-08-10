import { useMutation } from '@tanstack/react-query';

import { unlockAccountWithRecovery, WrongRecoveryCodeError } from '@stxapps/expo-crypto';
import { useApiClient } from '@stxapps/react';
import {
  ApiError,
  canonicalizeUsername,
  hexToBytes,
  recoveryDoorEndpoint,
  signInEndpoint,
  type SignInPayload,
} from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';

// The expo sibling of web-react's hooks/use-sign-in-with-recovery.ts: sign in
// with a RECOVERY CODE, the escape hatch when the password is lost. Same
// door-fetch → unwrap → sign shape as use-sign-in, but the recovery door (a
// cheap HKDF, not Argon2id) unwraps the SAME DEK, so the resulting session is
// identical to a password sign-in. The UI should route the user straight into
// set-a-new-password afterwards once that flow ports to expo. See the web hook
// for the full rationale; comments here cover the port.

// A single typed miss for every recovery-level failure — no such account/door,
// or a wrong code — kept indistinguishable (and distinct from the password miss
// so the "forgot password" UI can say "check your recovery code").
export class InvalidRecoveryCodeError extends Error {}

export function useSignInWithRecovery() {
  const api = useApiClient();
  const { setSession } = useAuth();

  return useMutation({
    mutationFn: async (values: { username: string; recoveryCode: string }) => {
      const username = canonicalizeUsername(values.username);

      // Step 1: fetch the RECOVERY-door blob (pre-auth). A 404 means no such
      // account, or one that never set up recovery — the same generic miss
      // either way (no enumeration oracle).
      let door;
      try {
        door = await api.call(recoveryDoorEndpoint, { username });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) throw new InvalidRecoveryCodeError();
        throw err;
      }

      // Step 2: HKDF the recovery-KEK over the normalized code and unwrap the
      // DEK. A wrong code fails on the GCM tag (WrongRecoveryCodeError) — that
      // IS the check.
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

      // Step 3: prove possession and exchange for a session — identical to a
      // password sign-in from here (same publicKey, same 'sign-in' action).
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

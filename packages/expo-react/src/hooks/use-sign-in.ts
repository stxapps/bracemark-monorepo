import { useMutation } from '@tanstack/react-query';

import { unlockAccount, WrongPasswordError } from '@stxapps/expo-crypto';
import { useApiClient } from '@stxapps/react';
import {
  ApiError,
  canonicalizeUsername,
  hexToBytes,
  passwordDoorEndpoint,
  signInEndpoint,
  type SignInPayload,
  type SignInValues,
} from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';

// The expo sibling of web-react's hooks/use-sign-in.ts: the SAME submit sequence
// (door fetch → KDF unwrap → sign → session), only the platform seams differ —
// expo-crypto's unlockAccount (native Argon2id, raw-byte encryptionKey) and this
// package's auth provider. See the web hook for the full rationale on each step;
// comments here cover the port.

// One typed failure for EVERY credential-level miss — unknown username, wrong
// password, or a key that doesn't match the stored credential. Deliberately
// indistinguishable so this isn't a username-existence oracle (docs/account.md);
// the form maps it to a root "incorrect username or password". Any other thrown
// error is an unexpected/transport failure.
export class InvalidCredentialsError extends Error {}

export function useSignIn() {
  const api = useApiClient();
  const { setSession } = useAuth();

  return useMutation({
    mutationFn: async (values: SignInValues) => {
      // Canonicalize ONCE at the boundary (trim→NFKC→lowercase) and use that form
      // for everything downstream — the door fetch, the KDF salt, the signed
      // payload, and the client-side stores (session record, syncMeta key).
      const username = canonicalizeUsername(values.username);

      // Step 1: fetch the PASSWORD-door blob (pre-auth — the client can't derive
      // anything without it). A 404 means no such account/door — surface it as
      // the SAME generic credential error as a wrong password.
      let door;
      try {
        door = await api.call(passwordDoorEndpoint, { username });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) throw new InvalidCredentialsError();
        throw err;
      }

      // Step 2: re-derive the password-KEK (Argon2id, run native off the JS
      // thread) and AEAD-unwrap the DEK. A wrong password fails the GCM tag
      // (WrongPasswordError) — that IS the password check; nothing is compared
      // server-side. Map ONLY that typed miss to the credential error: anything
      // else here is infrastructure and must surface as the generic failure.
      let account;
      try {
        account = await unlockAccount(username, values.password, {
          wrappedDek: hexToBytes(door.wrappedDek),
          iv: hexToBytes(door.iv),
        });
      } catch (err) {
        if (err instanceof WrongPasswordError) throw new InvalidCredentialsError();
        throw err;
      }

      // Step 3: prove possession of the DEK-derived key by signing a fresh,
      // action-bound payload, then POST it to exchange for a session. Sign and
      // send the EXACT JSON string the server verifies against — stringify once.
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
        // 401 = the key didn't match the stored credential (or a stale/forged
        // proof) — a credential miss either way.
        if (err instanceof ApiError && err.status === 401) throw new InvalidCredentialsError();
        throw err;
      }

      // The raw encryptionKey bytes ride back with the session for onSuccess to
      // persist in secure-store alongside the token, keyed by the CANONICAL
      // username. (Unlike create-account, no seedNewAccount here: an existing
      // account has server data, so the app blocks on a full first sync.)
      return { session, encryptionKey: account.encryptionKey, username };
    },
    // Persist via the auth context in onSuccess (not the component's mutateAsync
    // continuation) because it's hook-level and survives the form unmounting, so
    // a success that lands after navigation isn't lost. setSession both writes
    // the session store and flips app auth state to authenticated.
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

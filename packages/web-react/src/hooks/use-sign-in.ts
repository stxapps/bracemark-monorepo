'use client';

import { useMutation } from '@tanstack/react-query';

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
import { unlockAccount, WrongPasswordError } from '@stxapps/web-crypto';

import { useAuth } from '../contexts/auth-provider';

// App-local + web-only for the same reason as use-create-account: the submit
// sequence reaches for web-only crypto (@stxapps/web-crypto) and the web auth
// context, neither of which can live in the platform-agnostic @stxapps/react. The
// TanStack analog of a redux-thunk: one async unit you "dispatch" (mutate), with
// isPending/error for free and onSuccess as the store update.

// One typed failure for EVERY credential-level miss — unknown username, wrong
// password, or a key that doesn't match the stored credential. They're
// deliberately indistinguishable to the UI (and the user): collapsing them avoids
// a username-existence oracle and follows the generic "incorrect username or
// password" rule (docs/account.md). The form maps this to a root error; any other
// thrown error is an unexpected/transport failure.
export class InvalidCredentialsError extends Error {}

export function useSignIn() {
  const api = useApiClient();
  const { setSession } = useAuth();

  return useMutation({
    mutationFn: async (values: SignInValues) => {
      // Canonicalize ONCE at the boundary (trim→NFKC→lowercase) and use that form
      // for everything downstream — the door fetch, the KDF salt, the signed
      // payload, and the session record. The server and deriveUserSalt each
      // canonicalize defensively anyway; doing it here keeps the client-side
      // stores (session record, syncMeta key) on one form per account, so a
      // mixed-case sign-in resumes the same sync bookkeeping.
      const username = canonicalizeUsername(values.username);

      // Step 1: fetch the PASSWORD-door blob for this username. It's served pre-auth
      // because the client can't derive anything without it. A 404 means no such
      // account/door — surface it as the SAME generic credential error as a wrong
      // password so this isn't a username-enumeration oracle.
      let door;
      try {
        door = await api.call(passwordDoorEndpoint, { username });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) throw new InvalidCredentialsError();
        throw err;
      }

      // Step 2: re-derive the password-KEK and AEAD-unwrap the DEK, then derive the
      // same keypair + encryption key create-account produced. A wrong password
      // yields a wrong KEK and the GCM tag fails (unlockAccount throws
      // WrongPasswordError) — that IS the password check; nothing is compared
      // server-side at this step. Map ONLY that typed miss to the credential
      // error: anything else here is infrastructure (Argon2 worker OOM — it
      // allocates 64 MiB — or a failed worker-chunk load) and must surface as the
      // generic failure, not a phantom "incorrect username or password".
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
      // action-bound payload, then POST it to exchange for a session. `action`
      // binds the signature to sign-in (it can't be replayed as create-account);
      // the server verifies the signature AND that this publicKey equals the stored
      // credential for the username (the load-bearing check). Sign and send the
      // EXACT same JSON string the server verifies against — stringify once.
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
        // proof). With a correct password this is unreachable, but treat it as a
        // credential miss either way rather than a generic failure.
        if (err instanceof ApiError && err.status === 401) throw new InvalidCredentialsError();
        throw err;
      }

      // The encryptionKey is the non-extractable AES key for the user's data; it
      // can't be serialized, so it rides back with the session for onSuccess to
      // stash in client-only state alongside the token. The CANONICAL username
      // rides along too (not the raw mutate() input), so the session record and
      // syncMeta key stay on the one form every sign-in resolves to.
      return { session, encryptionKey: account.encryptionKey, username };
    },
    // Persist via the auth context in onSuccess (not the component's mutateAsync
    // continuation) because it's hook-level and survives the form unmounting (e.g.
    // browser back), so a success that lands after navigation isn't lost. setSession
    // both writes the session store and flips app auth state to authenticated, so
    // the UI reacts to the new login.
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

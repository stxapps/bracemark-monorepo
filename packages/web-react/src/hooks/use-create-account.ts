'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiClient, usernameAvailableQueryOptions } from '@stxapps/react';
import {
  ApiError,
  bytesToHex,
  canonicalizeUsername,
  createAccountEndpoint,
  type CreateAccountInput,
  type CreateAccountPayload,
} from '@stxapps/shared';
import { createAccount } from '@stxapps/web-crypto';

import { useAuth } from '../contexts/auth-provider';
import { seedNewAccount } from '../data/sync-store';

// App-local because account creation is web-only and the submit sequence reaches
// for web-only crypto — `platform:web` deps can't live in the `platform:agnostic`
// @stxapps/react. (The extension doesn't share this live session: the
// non-extractable encryptionKey can't cross the web↔extension boundary, so the
// extension unlocks on its own — its own sign-in — rather than inheriting it.)
// This is the TanStack analog of a redux-thunk: one async unit you "dispatch"
// (mutate), with isPending/error for free and onSuccess as the store update.

// Typed failures so the form can route each to the right field/message. The
// component owns react-hook-form's setError (form-local state); the hook owns
// the orchestration and just signals which kind of failure occurred.
export class UsernameTakenError extends Error {}
export class UsernameCheckError extends Error {}

export function useCreateAccount() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { setSession } = useAuth();

  return useMutation({
    mutationFn: async (values: CreateAccountInput) => {
      // Canonicalize ONCE at the boundary (trim→NFKC→lowercase) and use that form
      // for everything downstream — the KDF salt, the signed payload, and the
      // client-side stores (session record, syncMeta key). The server and
      // deriveUserSalt each canonicalize defensively anyway; doing it here keeps
      // every client-side key for one account identical regardless of typed case.
      const username = canonicalizeUsername(values.username);

      // Step 1: authoritative availability re-check on the exact submitted
      // value. fetchQuery reuses the live query's cache (also canonical-keyed),
      // so a paused-on name resolves instantly; the server still re-checks at
      // creation to close the type→submit race.
      let available: boolean;
      try {
        ({ available } = await queryClient.fetchQuery(
          usernameAvailableQueryOptions(api, username),
        ));
      } catch {
        throw new UsernameCheckError();
      }
      if (!available) throw new UsernameTakenError();

      // Step 2: create the account's keys from (username, password) via the
      // client KDF (Argon2id → HKDF, run off-thread in a worker). The root is a
      // fresh random DEK; the password-KEK (Argon2id over the username salt, so
      // two users with the same password get different keys) wraps it. Yields the
      // publicKey (the Ed25519 key the server verifies us by, not an identifier —
      // the server mints its own userId), a non-extractable AES-256-GCM key for
      // data, a `sign` closure over the private key (which never leaves
      // @stxapps/web-crypto), and `passwordDoor` — the wrapped DEK to persist
      // server-side.
      const account = await createAccount(
        username,
        values.password,
        values.recoveryCode ? { recoveryCode: values.recoveryCode } : undefined,
      );

      // Step 3: prove key ownership by signing a timestamped payload — which also
      // carries the wrapped door(s), so the signature covers exactly what the
      // server persists — then POST it to exchange for a session. The signed value
      // is the EXACT JSON string the server verifies against, so we stringify once
      // and both sign and send that string (see createAccountRequestSchema). The
      // recovery door is included only when the ceremony minted a code.
      const payload = JSON.stringify({
        action: 'create-account',
        username,
        publicKey: account.publicKey,
        passwordDoor: {
          wrappedDek: bytesToHex(account.passwordDoor.wrappedDek),
          iv: bytesToHex(account.passwordDoor.iv),
        },
        ...(account.recoveryDoor
          ? {
              recoveryDoor: {
                wrappedDek: bytesToHex(account.recoveryDoor.wrappedDek),
                iv: bytesToHex(account.recoveryDoor.iv),
              },
            }
          : {}),
        timestamp: Date.now(),
      } satisfies CreateAccountPayload);
      const signature = await account.sign(payload);

      // POST to exchange the proof for a session. The server re-checks username
      // uniqueness here (the directory claim) to close the step-1→step-3 race; a
      // 409 routes back to the form's setError as UsernameTakenError. This is a
      // write, so it isn't cancelled on unmount.
      let session;
      try {
        session = await api.call(createAccountEndpoint, { payload, signature });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) throw new UsernameTakenError();
        throw err;
      }

      // The encryptionKey is the non-extractable AES key for the user's data; it
      // can't be serialized, so it rides back with the session for onSuccess to
      // stash in client-only state alongside the session token. The CANONICAL
      // username rides along too (not the raw mutate() input), so the stores are
      // keyed by the one form every later sign-in resolves to.
      return { session, encryptionKey: account.encryptionKey, username };
    },
    // Persist via the auth context in onSuccess (not the component's mutateAsync
    // continuation) because it's hook-level and survives the form unmounting (e.g.
    // browser back), so a success that lands after navigation isn't lost.
    // setSession both writes the session store and flips app auth state to
    // authenticated, so the UI reacts to the new login. The component keeps only
    // the failure→setError mapping, which is UI feedback and fine to drop when
    // gone.
    onSuccess: async ({ session, encryptionKey, username }) => {
      // A brand-new account has no server data, so mark its first sync done up
      // front (empty cursor). This lets InitialSyncGate render the app immediately with
      // no pull — the sign-in path, which has no such flag, blocks on a full
      // sync instead. Seed before setSession so the flag is in place by the time
      // the auth flip navigates into the (app) layout. See sync-store.
      await seedNewAccount(username);
      await setSession({
        username,
        token: session.token,
        expiresAt: session.expiresAt,
        encryptionKey,
      });
    },
  });
}

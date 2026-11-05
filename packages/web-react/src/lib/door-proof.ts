import {
  type ApiClient,
  ApiError,
  ApiTimeoutError,
  hexToBytes,
  readPasswordDoorEndpoint,
  readRecoveryDoorEndpoint,
} from '@stxapps/shared';
import { type DoorOpener } from '@stxapps/web-crypto';

import { InvalidCredentialsError } from '../hooks/use-sign-in';
import { InvalidRecoveryCodeError } from '../hooks/use-sign-in-with-recovery';

// The plumbing both door-rotating hooks share — useChangePassword and
// useRecoveryCode each prove an existing door, re-wrap the DEK, and save the new
// door — kept out of either hook so neither imports the other. Only
// `DoorProofInput` and `UnconfirmedSaveError` are part of the package's surface
// (index.ts); the rest is internal.

// How the caller proves it may re-wrap the DEK. The two cases the "Change
// password" UI exposes (docs/account.md): "I know my current password" and "I
// forgot it (but have my recovery code)".
export type DoorProofInput =
  { kind: 'password'; currentPassword: string } | { kind: 'recovery'; recoveryCode: string };

// Fetch the wrapped door the proof will open and assemble the web-crypto
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
      door = await api.call(readPasswordDoorEndpoint, { username });
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
    door = await api.call(readRecoveryDoorEndpoint, { username });
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

// The save itself went out and no answer came back — the call timed out, or the
// connection dropped mid-flight. The server may have stored the new door anyway:
// when the platform is slow, a call can outlast the client deadline
// (DEFAULT_CALL_TIMEOUT_MS) while its write still lands. "Please try again" is the wrong
// thing to say then. A password change settles it by asking the door (`opensNow` in
// hooks/use-change-password.ts), and
// throws this only when the server cannot be reached for that either. A new recovery
// code cannot be settled — the code that may have landed was never shown — so it
// always throws this, and the form says to generate another.
// Thrown only for the FINAL save. A failure before it (the door fetch, the
// Argon2 run) wrote nothing and stays the ordinary "please try again".
export class UnconfirmedSaveError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The save was sent but no answer came back.', options);
    this.name = 'UnconfirmedSaveError';
  }
}

// No answer at all: our deadline, or fetch's TypeError for a dropped connection.
// An ApiError is an answer — the server replied, so its handler ran to an end.
export function isNoAnswer(err: unknown): boolean {
  return err instanceof ApiTimeoutError || err instanceof TypeError;
}

// Map the web-crypto open failures (wrong password / wrong recovery code) to the
// forms' typed misses; re-throw anything else (Argon2 worker failure, transport).
export function mapOpenError(err: unknown): never {
  // Both WrongPasswordError and WrongRecoveryCodeError are thrown from
  // @stxapps/web-crypto; check by name to avoid importing both classes everywhere.
  if (err instanceof Error && err.name === 'WrongPasswordError')
    throw new InvalidCredentialsError();
  if (err instanceof Error && err.name === 'WrongRecoveryCodeError') {
    throw new InvalidRecoveryCodeError();
  }
  throw err;
}

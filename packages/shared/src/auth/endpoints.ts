import { z } from 'zod';

import { API_V1, defineEndpoint } from '../api/endpoint';
import { usernameSchema } from './credentials';

// Auth endpoint contracts. Request schemas reuse the pure validators from
// ./credentials so the field rules (length, charset) are defined exactly once
// and enforced identically on the client form and the server.

export const checkUsernameRequestSchema = z.object({
  username: usernameSchema,
});
export type CheckUsernameRequest = z.infer<typeof checkUsernameRequestSchema>;

export const checkUsernameResponseSchema = z.object({
  available: z.boolean(),
});
export type CheckUsernameResponse = z.infer<typeof checkUsernameResponseSchema>;

// GET /v1/auth/username-available?username=… → { available }
// Cheap pre-submit check so the create-account form can flag a taken username
// before the KDF + challenge-signing dance. Not authoritative — account creation
// still re-checks server-side to close the race.
export const checkUsernameEndpoint = defineEndpoint({
  method: 'GET',
  path: `${API_V1}/auth/username-available`,
  request: checkUsernameRequestSchema,
  response: checkUsernameResponseSchema,
});

// --- create account ---------------------------------------------------------

// Fixed-length lowercase-hex of `bytes` bytes — the wire form for binary material
// (see crypto/encoding.ts). Pins exact lengths so a malformed key/blob is a clean
// 400 at the contract boundary, not a crash deeper in.
const hexBytes = (bytes: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`), `expected ${bytes}-byte lowercase hex`);

// A wrapped door as it crosses the wire: the AES-256-GCM ciphertext+tag (any
// door wraps the same 32-byte DEK → 48 bytes) and its 12-byte IV, hex-encoded.
// `doorType` is implied by the endpoint/field it appears in (the wrap AAD binds
// it cryptographically anyway — see dekWrapAad), so the wire shape is identical
// for the password, recovery, and (future) passkey doors.
export const wireDoorSchema = z.object({
  wrappedDek: hexBytes(48),
  iv: hexBytes(12),
});
export type WireDoor = z.infer<typeof wireDoorSchema>;

// Back-compat name: the password door has this exact shape. Kept so existing
// references (createAccount payload, password-door fetch) read intently.
export const wirePasswordDoorSchema = wireDoorSchema;

// The exact object the client signs to prove it holds the private key for the
// `publicKey` it's registering (see "the load-bearing sign-in check" in
// docs/account.md). `action` binds the signature to this operation so it can't be
// replayed as a sign-in; `timestamp` bounds replay; `passwordDoor` is the wrapped
// DEK the server persists, so the signature also covers what gets stored. The
// signature is verified over the EXACT JSON string of this object — hence it
// travels as a raw string (createAccountRequestSchema) and is parsed back with
// this schema server-side, never re-serialized.
export const createAccountPayloadSchema = z.object({
  action: z.literal('create-account'),
  username: usernameSchema,
  publicKey: hexBytes(32),
  passwordDoor: wirePasswordDoorSchema,
  // The recovery door is OPTIONAL — the ceremony lets users skip it
  // (docs/account.md). When present it wraps the SAME DEK as the password door,
  // and the signature covers it too, so the server persists exactly what was
  // signed. Absent → the account starts with only a password door (a persistent
  // "no recovery set" nudge lives in settings).
  recoveryDoor: wireDoorSchema.optional(),
  timestamp: z.number().int(),
});
export type CreateAccountPayload = z.infer<typeof createAccountPayloadSchema>;

// POST body: the signed payload as a raw JSON STRING plus its Ed25519 signature.
// `payload` is a string (not a nested object) on purpose — the server must verify
// the signature over the same bytes the client signed, and re-serializing a parsed
// object could reorder keys and break verification.
export const createAccountRequestSchema = z.object({
  payload: z.string(),
  signature: hexBytes(64),
});
export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;

// Only the raw bearer `token` (the capability the client authenticates with) and
// its `expiresAt` cross the wire. The session row's PK (`sessionId`) is
// server-internal — the auth guard resolves a session by hashing the token, and an
// authenticated logout revokes it without the client ever holding its id.
export const createAccountResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.number(),
});
export type CreateAccountResponse = z.infer<typeof createAccountResponseSchema>;

// POST /v1/auth/create-account → { token, expiresAt }
// Registers an account: verifies proof-of-possession, claims the username, stores
// the publicKey + wrapped DEK (password door), and returns a fresh session. The
// directory claim re-checks uniqueness server-side to close the type→submit race.
export const createAccountEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/auth/create-account`,
  request: createAccountRequestSchema,
  response: createAccountResponseSchema,
});

// --- sign in -----------------------------------------------------------------

// Step 1 of sign-in is a PRE-AUTH door fetch: the client names a username and
// gets back that account's password-door wrapped DEK, which it unwraps with
// Argon2id(password, salt) to recover the DEK and derive its keys. A wrong
// password fails on the GCM tag client-side — that IS the password check; nothing
// is compared here. Served before authentication because the client can't derive
// anything without the blob (it's the offline-attack oracle the entropy gate
// defends — see docs/account.md "why the wrapped DEK is served pre-auth").
export const passwordDoorRequestSchema = z.object({
  username: usernameSchema,
});
export type PasswordDoorRequest = z.infer<typeof passwordDoorRequestSchema>;

// The response is exactly the wrapped password door — same { wrappedDek, iv } wire
// shape the client sends UP at create-account, reused here for the round trip.
export type PasswordDoorResponse = z.infer<typeof wirePasswordDoorSchema>;

// GET /v1/auth/password-door?username=… → { wrappedDek, iv }
export const passwordDoorEndpoint = defineEndpoint({
  method: 'GET',
  path: `${API_V1}/auth/password-door`,
  request: passwordDoorRequestSchema,
  response: wirePasswordDoorSchema,
});

// The RECOVERY door's pre-auth fetch — the exact analogue of the password-door
// fetch, for the "forgot my password" path. The client names a username and gets
// back that account's recovery-door wrapped DEK, which it unwraps with the
// recovery code (a cheap HKDF, not Argon2id) to recover the DEK. Same offline-
// oracle posture as the password door (served pre-auth, rate-limited), but here
// the code is high-entropy so brute force is infeasible regardless. 404s when the
// account has no recovery door (it was skipped at create) — indistinguishable, on
// this pre-auth path, from a missing account.
export const recoveryDoorRequestSchema = z.object({
  username: usernameSchema,
});
export type RecoveryDoorRequest = z.infer<typeof recoveryDoorRequestSchema>;
export type RecoveryDoorResponse = z.infer<typeof wireDoorSchema>;

// GET /v1/auth/recovery-door?username=… → { wrappedDek, iv }
export const recoveryDoorEndpoint = defineEndpoint({
  method: 'GET',
  path: `${API_V1}/auth/recovery-door`,
  request: recoveryDoorRequestSchema,
  response: wireDoorSchema,
});

// Step 3: the signed proof the client POSTs to exchange for a session. Mirrors the
// create-account payload, but with `action: 'sign-in'` (so a create-account proof
// can't be replayed here, and vice versa) and NO passwordDoor — the door already
// exists server-side; this flow only proves possession of the DEK-derived key. The
// server verifies the signature over the EXACT JSON string, then checks
// `publicKey` against the STORED credential for the username (the load-bearing
// check — see docs/account.md "the two identifiers").
export const signInPayloadSchema = z.object({
  action: z.literal('sign-in'),
  username: usernameSchema,
  publicKey: hexBytes(32),
  timestamp: z.number().int(),
});
export type SignInPayload = z.infer<typeof signInPayloadSchema>;

// POST body: the signed payload as a raw JSON STRING plus its Ed25519 signature —
// a string (not a nested object) for the same reason as create-account: the server
// must verify the signature over the same bytes the client signed.
export const signInRequestSchema = z.object({
  payload: z.string(),
  signature: hexBytes(64),
});
export type SignInRequest = z.infer<typeof signInRequestSchema>;

export const signInResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.number(),
});
export type SignInResponse = z.infer<typeof signInResponseSchema>;

// POST /v1/auth/sign-in → { token, expiresAt }
// Verifies proof-of-possession, confirms the presented publicKey matches the
// stored credential for the username, and returns a fresh session.
export const signInEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/auth/sign-in`,
  request: signInRequestSchema,
  response: signInResponseSchema,
});

// --- sign out ---------------------------------------------------------------

// No request fields: the session to revoke is identified by the bearer token
// (the auth guard resolves it), so the body is empty. An object schema (rather
// than nothing) keeps the contract uniform — the client still sends `{}` as JSON.
export const signOutRequestSchema = z.object({});
export type SignOutRequest = z.infer<typeof signOutRequestSchema>;

export const signOutResponseSchema = z.object({
  ok: z.literal(true),
});
export type SignOutResponse = z.infer<typeof signOutResponseSchema>;

// POST /v1/auth/sign-out → { ok: true }
// Revokes the current session server-side (deletes its row, so the bearer token
// stops authenticating). Protected: requires the session's bearer token. The
// client also drops its local session regardless, so a network failure here
// still signs the user out locally — the row then ages out via TTL.
export const signOutEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/auth/sign-out`,
  request: signOutRequestSchema,
  response: signOutResponseSchema,
});

// Like sign-out, but revokes every OTHER session for the account and KEEPS the
// caller's own — the body is empty for the same reason (the caller is named by
// the bearer token). Session-only, deliberately: this is the plural of sign-out
// (also session-only), touches no doors or credentials, and is low-harm and
// reversible (the owner just signs back in), so it does NOT require the fresh
// signed proof that door rotations / delete-account do. It's also the primitive
// change-password uses server-side to cut off other sessions after a rotation.
export const signOutOthersRequestSchema = z.object({});
export type SignOutOthersRequest = z.infer<typeof signOutOthersRequestSchema>;

export const signOutOthersResponseSchema = z.object({
  ok: z.literal(true),
});
export type SignOutOthersResponse = z.infer<typeof signOutOthersResponseSchema>;

// POST /v1/auth/sign-out-others → { ok: true }
export const signOutOthersEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/auth/sign-out-others`,
  request: signOutOthersRequestSchema,
  response: signOutOthersResponseSchema,
});

// --- delete account -----------------------------------------------------------

// The full account teardown: every synced object, every session, the doors
// (wrapped DEKs — the cryptographic kill), and the account row; the username is
// tombstoned (stays occupied), and the subscription must not be live (409). See
// docs/data-lifecycle.md.
//
// Guarded by a FRESH signed proof, not just the bearer token: this is the one
// action where "stolen session token = total, irreversible loss" is
// unacceptable, so the client must re-enter the password, unwrap the DEK, and
// sign — the same proof-of-possession machinery as sign-in, bound to its own
// `action` literal so neither a sign-in nor a create-account proof can be
// replayed here (and vice versa). The route ALSO requires the bearer token, and
// the server checks the proof resolves to the SAME account the session names —
// a signed proof for account A can never tear down account B.
export const deleteAccountPayloadSchema = z.object({
  action: z.literal('delete-account'),
  username: usernameSchema,
  publicKey: hexBytes(32),
  timestamp: z.number().int(),
});
export type DeleteAccountPayload = z.infer<typeof deleteAccountPayloadSchema>;

// POST body: the signed payload as a raw JSON STRING plus its Ed25519 signature —
// a string (not a nested object) for the same reason as create-account/sign-in:
// the server must verify the signature over the same bytes the client signed.
export const deleteAccountRequestSchema = z.object({
  payload: z.string(),
  signature: hexBytes(64),
});
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;

export const deleteAccountResponseSchema = z.object({
  ok: z.literal(true),
});
export type DeleteAccountResponse = z.infer<typeof deleteAccountResponseSchema>;

// POST /v1/auth/delete-account → { ok: true }
// Refuses with 409 `subscription_active` while a subscription would keep
// billing (renewing, or in dunning) — the user cancels via the Paddle portal
// first. A canceled-but-still-entitled subscription does NOT block: the user
// already ended billing, and holding their deletion hostage until the period
// runs out would be hostile (the remaining paid time is forfeited — the client
// says so in its copy).
export const deleteAccountEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/auth/delete-account`,
  request: deleteAccountRequestSchema,
  response: deleteAccountResponseSchema,
});

// --- door management (authed) -------------------------------------------------
//
// Change the password door and generate/regenerate the recovery door. Both are
// TIER-1 door rotations (docs/account.md): the DEK is unchanged, so the publicKey,
// derived keys, all data, and any live session stay valid — only one
// `account_keys` row is re-wrapped.
//
// Both are DOUBLE-guarded exactly like delete-account: requireAuth names the
// account, and a FRESH signed proof proves the caller still holds the DEK-derived
// key. That proof is the load-bearing guard here — a stolen session token alone
// can't rotate a door, because forging a valid new wrapped door requires the DEK
// (which the session never carries), and the proof is only producible by someone
// who just opened a real door to recover that DEK. The new wrapped door rides
// INSIDE the signed payload so the signature covers exactly what gets stored.

// Change the password door. The client opened an existing door (current password
// OR recovery code — a client-side detail the server never sees) to recover the
// DEK, re-wrapped it under the new password's KEK, and signs this. `publicKey` is
// unchanged by a password change, so the load-bearing stored-credential check
// still holds.
export const changePasswordPayloadSchema = z.object({
  action: z.literal('change-password'),
  username: usernameSchema,
  publicKey: hexBytes(32),
  passwordDoor: wireDoorSchema,
  timestamp: z.number().int(),
});
export type ChangePasswordPayload = z.infer<typeof changePasswordPayloadSchema>;

export const changePasswordRequestSchema = z.object({
  payload: z.string(),
  signature: hexBytes(64),
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const changePasswordResponseSchema = z.object({ ok: z.literal(true) });
export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;

// POST /v1/auth/change-password → { ok: true }
export const changePasswordEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/auth/change-password`,
  request: changePasswordRequestSchema,
  response: changePasswordResponseSchema,
});

// Generate or regenerate the recovery door (upsert — same call whether the
// account had one or not). The client minted a fresh recovery code, re-wrapped the
// DEK under its KEK, and signs this. Regenerating invalidates the previous code
// (the old wrapped blob is replaced).
export const putRecoveryDoorPayloadSchema = z.object({
  action: z.literal('put-recovery-door'),
  username: usernameSchema,
  publicKey: hexBytes(32),
  recoveryDoor: wireDoorSchema,
  timestamp: z.number().int(),
});
export type PutRecoveryDoorPayload = z.infer<typeof putRecoveryDoorPayloadSchema>;

export const putRecoveryDoorRequestSchema = z.object({
  payload: z.string(),
  signature: hexBytes(64),
});
export type PutRecoveryDoorRequest = z.infer<typeof putRecoveryDoorRequestSchema>;

export const putRecoveryDoorResponseSchema = z.object({ ok: z.literal(true) });
export type PutRecoveryDoorResponse = z.infer<typeof putRecoveryDoorResponseSchema>;

// POST /v1/auth/recovery-door → { ok: true }  (upsert the recovery door)
export const putRecoveryDoorEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/auth/recovery-door`,
  request: putRecoveryDoorRequestSchema,
  response: putRecoveryDoorResponseSchema,
});

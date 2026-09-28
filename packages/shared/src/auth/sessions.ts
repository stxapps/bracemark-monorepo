// The session contract both ends share: how long a finished session's row is
// kept, the three codes bracemark-api answers a rejected bearer token with, and
// the client-side vocabulary those codes map onto. See docs/sessions.md.
//
// It is `platform:agnostic`, so it must stay portable to all three engines
// (browsers, workerd, Hermes): no platform runtime, nothing but this package.
// See docs/architecture.md.

import { ApiError } from '../api/client';

// How long bracemark-api keeps a session's row after the session ends — expired
// or revoked — before cleanup deletes it (docs/sessions.md, _revocation, expiry
// and unknown tokens_). It is the window in which a device that comes back can
// still be told `session_revoked`, and so erase its copy.
//
// It is also a public promise. /privacy (_How long we keep it_) and
// /delete-account (_What is deleted_, _What is kept_) state it in words, and
// they read `label` rather than typing it, so the pages and the cleanup that
// enforces the number can't drift. The api's cleanup reads `days`
// (`SESSION_PURGE_MS`, apps/bracemark-api/src/services/session.ts).
export const SESSION_RETENTION = {
  days: 365,
  /** As the public pages say it, mid-sentence: "…for a year…". */
  label: 'a year',
} as const;

// The 401 codes `requireAuth` answers a presented bearer token with, one per
// failure it can tell apart. `unauthorized` (no bearer header at all) is not
// here: it isn't a verdict on a session, and a client that sent a token never
// receives it.
export const SESSION_ERROR = {
  // The token's hash matches no row: never issued, purged, or the table lost.
  // An ABSENCE, not a message — so it must never wipe anything.
  unknown: 'session_unknown',
  // The row carries an explicit revocation marker (sign-out, sign out other
  // devices, delete account). The one code that may erase a device's copy.
  revoked: 'session_revoked',
  // An unrevoked row past its idle deadline, or cut off by a password change.
  expired: 'session_expired',
} as const;

// What a client does about a rejected token, collapsed to the two outcomes that
// differ: `revoked` may wipe (for the current session generation only), and
// `expired` — which `session_unknown` joins — keeps everything and asks for a
// sign-in. See docs/sessions.md, _the rule that carries it_.
export type SessionVerdict = 'revoked' | 'expired';

// The verdict carried by one response, or null. Only OUR envelope counts: a 401
// from a proxy, a gateway's HTML error page, a codeless 401, any other status, or
// a body that doesn't parse is null — "a failed request", never a verdict. A bare
// `status === 401` check is exactly what this replaces.
export function sessionVerdictFromResponse(status: number, body: string): SessionVerdict | null {
  if (status !== 401) return null;
  let code: unknown;
  try {
    code = (JSON.parse(body) as { error?: unknown } | null)?.error;
  } catch {
    return null;
  }
  if (code === SESSION_ERROR.revoked) return 'revoked';
  if (code === SESSION_ERROR.expired || code === SESSION_ERROR.unknown) return 'expired';
  return null;
}

// The same, off a thrown ApiError — for callers that see the error rather than
// the response (the sync engine, a probe).
export function sessionVerdictOf(e: unknown): SessionVerdict | null {
  return e instanceof ApiError ? sessionVerdictFromResponse(e.status, e.body) : null;
}

// A signed-in device's session is `active`, or `expired` — reauthentication
// required, library kept, sync paused. Signed out is the absence of a record.
// Persisted with the record, so a relaunch doesn't repeat a cycle it already
// knows will fail.
export type SessionState = 'active' | 'expired';

// A local identity for one adopted token: minted on sign-in, create-account and
// resume, and captured with the token by every request, so a verdict can be
// checked against the session that SENT it (docs/sessions.md, _concurrent
// requests and shared local state_). Equality is all it's used for — never
// ordering, never sent to the server, not a credential — so a timestamp plus
// randomness is enough, and it needs no crypto API (Hermes has none built in).
export function newSessionGeneration(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

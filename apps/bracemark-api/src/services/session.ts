import { SESSION_RETENTION } from '@stxapps/shared';

import { sessionsRepo } from '../db/repositories/sessions';
import type { Bindings } from '../lib/env';
import { hashToken, newId, newSessionToken } from '../lib/ids';

// Session lifecycle, SESSIONS_DB-backed. The auth GUARD (middleware/auth.ts)
// does the per-request read directly via sessionsRepo and asks renewSession to
// slide the deadline; this service owns every WRITE — minting, renewing,
// revoking, expiring and purging. See docs/sessions.md.

const DAY_MS = 24 * 60 * 60 * 1000;

// The idle window: a session expires this long after its last successful
// renewal. Sliding, and decided here — no client holds a deadline.
export const SESSION_IDLE_MS = 90 * DAY_MS;
// The minimum interval between successful renewals of one session, which bounds
// the guard's writes to about one per session per day.
export const SESSION_SLIDE_MS = DAY_MS;
// How long a finished session's row is kept — after expiry for an unrevoked row,
// after revocation for a revoked one. A public promise (/privacy,
// /delete-account), so the number lives in @stxapps/shared.
export const SESSION_PURGE_MS = SESSION_RETENTION.days * DAY_MS;

export type IssuedSession = {
  // The RAW token. Returned to the client exactly once; only its hash is stored.
  token: string;
  sessionId: string;
};

// Mint a session for a user. We persist the token HASH (never the raw token) and
// hand the raw token back to the caller to return to the client. `accountDbId`
// is denormalized onto the session so the auth guard can route to the user's
// accounts shard without a directory hop.
export async function issueSession(
  env: Bindings,
  user: { id: string; accountDbId: string },
): Promise<IssuedSession> {
  const token = newSessionToken();
  const sessionId = newId();
  const now = Date.now();

  await sessionsRepo(env.SESSIONS_DB).insert({
    id: sessionId,
    tokenHash: await hashToken(token),
    userId: user.id,
    accountDbId: user.accountDbId,
    expiresAt: now + SESSION_IDLE_MS,
    now,
  });

  return { token, sessionId };
}

// Slide an authenticated session's idle deadline (the throttle and the
// no-resurrection rules live in the repository's predicate). `now` is the
// guard's own timestamp — the one it judged the session live at.
export function renewSession(env: Bindings, sessionId: string, now: number): Promise<boolean> {
  return sessionsRepo(env.SESSIONS_DB).renew(sessionId, now, SESSION_IDLE_MS, SESSION_SLIDE_MS);
}

// Sign-out: mark this session revoked. The row stays, so the token answers
// `session_revoked` until cleanup.
export async function revokeSession(env: Bindings, sessionId: string): Promise<void> {
  await sessionsRepo(env.SESSIONS_DB).revokeById(sessionId, Date.now());
}

// Revoke every OTHER session for the caller's account, keeping the caller's own
// alive (identified by `session.id`). Backs "sign out other devices" — the plural
// of revokeSession, and the control whose purpose is to make a lost device
// forget. A password change does NOT use it; see expireOtherSessions.
export async function revokeOtherSessions(
  env: Bindings,
  session: { id: string; userId: string },
): Promise<void> {
  await sessionsRepo(env.SESSIONS_DB).revokeByUserIdExcept(session.userId, session.id, Date.now());
}

// Revoke every session of an account, the caller's included — account deletion.
export async function revokeAllSessions(env: Bindings, userId: string): Promise<void> {
  await sessionsRepo(env.SESSIONS_DB).revokeByUserId(userId, Date.now());
}

// Expire (never revoke) every OTHER unrevoked session — the password change. It
// cuts off whoever held the old password as completely as a revocation (an
// expired row can't authenticate, and renewal won't revive it), but the user's
// own devices keep their unsynced edits and resume with the new password.
export async function expireOtherSessions(
  env: Bindings,
  session: { id: string; userId: string },
): Promise<void> {
  await sessionsRepo(env.SESSIONS_DB).expireByUserIdExcept(session.userId, session.id, Date.now());
}

// Cleanup (the daily cron, worker.ts): drop rows past SESSION_PURGE_MS on their
// own clock. A token whose row is gone gets `session_unknown`, which keeps data.
export function purgeSessions(env: Bindings, now: number = Date.now()): Promise<number> {
  return sessionsRepo(env.SESSIONS_DB).purge(now, SESSION_PURGE_MS);
}

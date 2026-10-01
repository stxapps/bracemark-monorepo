import { d1, quote } from './d1';
import { findUserId } from './plan';

// Purge every session row an account holds — what the daily cleanup does to a
// session a year past its end, and what a restore or an emptied table does to
// all of them (docs/sessions.md, _the sessions database — never restored
// backward_). The device still holds its token; the server no longer knows it,
// so its next request answers `session_unknown`, which must keep the library.
//
// Server-side on purpose. The web case forges the token in the page's own
// storage instead (web/account.e2e.ts, forgeStoredToken), but a device's token
// sits in the Keychain / Keystore, out of the runner's reach. Deleting the row
// gives the device the same verdict without a test hook in the app — and it is
// the purge's own write, not an approximation of it.
//
// Every session, not just the device's: the provisioning browser's is already
// closed, and the runner reads the result back from a fresh sign-in.
export async function forgetSessions(username: string): Promise<void> {
  const userId = await findUserId(username);
  if (!userId) throw new Error(`no user id for ${username}; was the account created?`);
  const where = `WHERE user_id = ${quote(userId)}`;
  // A purge of nothing would pass every assertion after it with the device
  // never having asked — so the device's row has to be there first.
  if ((await countSessions(where)) === 0) {
    throw new Error(`${username} holds no session to forget; did the device sign in?`);
  }
  await d1('SESSIONS_DB', `DELETE FROM sessions ${where}`);
  const left = await countSessions(where);
  if (left !== 0) throw new Error(`${left} sessions of ${username} survived the purge`);
}

async function countSessions(where: string): Promise<number> {
  const rows = await d1('SESSIONS_DB', `SELECT COUNT(*) AS n FROM sessions ${where}`);
  return Number(rows[0]?.n ?? 0);
}

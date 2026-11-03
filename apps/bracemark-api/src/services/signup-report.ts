import type { Bindings } from '../lib/env';
import { signupCapOf } from './signup-cap';

// The daily cron's account-creation line: how many accounts the last 24 h made, and
// how many networks reached the signup cap yesterday. A flood of new accounts
// shows up here a day before it shows up as storage.
//
// One console.log every day, so the normal level is on record. That record is
// what SIGNUP_ALERT_PER_DAY gets set from. Above that threshold the line is a
// console.error instead, which is what an error-level filter or alert in Workers
// Logs finds. With the threshold unset, it is always the log line.
//
// `usernames.created_at` counts every claim, tombstones included. A deleted
// account was still created that day.

const DAY_MS = 86_400_000;

export type SignupReport = { created: number; cappedNetworks: number };

export async function reportSignups(
  env: Bindings,
  now: number = Date.now(),
): Promise<SignupReport> {
  const createdRow = await env.DIRECTORY_DB.prepare(
    `SELECT COUNT(*) AS n FROM usernames WHERE created_at >= ?`,
  )
    .bind(now - DAY_MS)
    .first<{ n: number }>();
  const created = createdRow?.n ?? 0;

  // Yesterday's rows, read before the same cron run purges them (worker.ts).
  const cap = signupCapOf(env);
  let cappedNetworks = 0;
  if (cap !== null) {
    const row = await env.SESSIONS_DB.prepare(
      `SELECT COUNT(*) AS n FROM signup_counts WHERE day = ? AND count > ?`,
    )
      .bind(Math.floor(now / DAY_MS) - 1, cap)
      .first<{ n: number }>();
    cappedNetworks = row?.n ?? 0;
  }

  const line = `signups: ${created} accounts in the last 24 h; ${cappedNetworks} networks reached the daily cap yesterday`;
  const threshold = Number(env.SIGNUP_ALERT_PER_DAY);
  if (Number.isInteger(threshold) && threshold > 0 && created > threshold) {
    console.error(`${line} (above the alert threshold of ${threshold})`);
  } else {
    console.log(line);
  }
  return { created, cappedNetworks };
}

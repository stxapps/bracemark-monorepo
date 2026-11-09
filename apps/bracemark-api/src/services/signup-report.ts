import { signupCountsRepo } from '../db/repositories/signup-counts';
import { usernamesRepo } from '../db/repositories/usernames';
import type { Bindings } from '../lib/env';
import { signupCapEnforcedOf } from './signup-cap';

// The daily cron's account-creation line: how many accounts the last 24 h made,
// how many networks went past their signup cap yesterday, and how many signups
// the busiest network made. A flood of new accounts shows up here a day before it
// shows up as storage.
//
// The last two are what the cap is decided from (services/signup-cap.ts). The
// deployed caps are high and enforced, so the busiest network is the figure to
// read, well before any network reaches the cap: a busy network on an ordinary
// day, with no jump in the total, is a crowd on shared wifi, and a lone busy
// network on the day the total jumps is a source. Networks past an enforced cap
// are people (or scripts) that were refused; in observe mode they are what the
// cap WOULD have refused.
//
// One console.log every day, so the normal level is on record. That record is
// what SIGNUP_ALERT_PER_DAY gets set from. Above that threshold the line is a
// console.error instead, which is what an error-level filter or alert in Workers
// Logs finds. With the threshold unset, it is always the log line.

const DAY_MS = 86_400_000;

export type SignupReport = { created: number; cappedNetworks: number; busiest: number };

export async function reportSignups(
  env: Bindings,
  now: number = Date.now(),
): Promise<SignupReport> {
  // Every claim, tombstones included (usernamesRepo.countCreatedSince).
  const created = await usernamesRepo(env.DIRECTORY_DB).countCreatedSince(now - DAY_MS);

  // Yesterday's rows, read before the same cron run purges them (worker.ts). Each
  // row carries the cap it was counted against, so the two families' caps need
  // no sorting out here, and with both caps off there are no rows to count.
  const counts = signupCountsRepo(env.SESSIONS_DB);
  const yesterday = Math.floor(now / DAY_MS) - 1;
  const [cappedNetworks, busiest] = await Promise.all([
    counts.countOverCap(yesterday),
    counts.busiest(yesterday),
  ]);

  const mode = signupCapEnforcedOf(env) ? 'refused' : 'observed, not refused';
  const line = `signups: ${created} accounts in the last 24 h; yesterday ${cappedNetworks} networks went past their daily cap (${mode}) and the busiest network made ${busiest} signups`;
  const threshold = Number(env.SIGNUP_ALERT_PER_DAY);
  if (Number.isInteger(threshold) && threshold > 0 && created > threshold) {
    console.error(`${line} (above the alert threshold of ${threshold})`);
  } else {
    console.log(line);
  }
  return { created, cappedNetworks, busiest };
}

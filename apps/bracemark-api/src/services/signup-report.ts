import { signupCountsRepo } from '../db/repositories/signup-counts';
import { type SignupDay, signupDaysRepo } from '../db/repositories/signup-days';
import { usernamesRepo } from '../db/repositories/usernames';
import type { Bindings } from '../lib/env';
import { signupCapEnforcedOf, signupCapsOf } from './signup-cap';

// The daily cron's signup figures: how many accounts the last 24 h made, how many
// networks went past their signup cap yesterday, and how many signups the busiest
// network made. A flood of new accounts shows up here a day before it shows up as
// storage.
//
// The last two are what the cap is decided from (services/signup-cap.ts). The
// deployed caps are high and enforced, so the busiest network is the figure to
// read, well before any network reaches the cap: a busy network on an ordinary
// day, with no jump in the total, is a crowd on shared wifi, and a lone busy
// network on the day the total jumps is a source. Networks past an enforced cap
// are people (or scripts) that were refused; in observe mode they are what the
// cap WOULD have refused.
//
// KEPT AS TOTALS, ONE ROW PER DAY (signup_days, db/repositories/signup-days.ts).
// Those two figures exist only in signup_counts, and the same cron deletes every
// past day of it right after this runs (worker.ts), so they are written down
// here or lost. A row holds totals and the caps in force — never a network or
// its hash — and lasts SIGNUP_DAYS_KEPT days: long enough to read a whole past
// month back. The figures are read from that table, not from the log line,
// which Workers Logs keeps for about a week.
//
// EVERY FINISHED DAY GETS A ROW, ZEROS INCLUDED, from the day after the newest
// row to yesterday. A day nobody signed up has no signup_counts rows, and
// without a zero row it would look the same as a day the cron never ran. And
// a skipped run skips its purge too, so its days are still in signup_counts
// when the next run comes, and are written exactly. `INSERT OR REPLACE` makes
// a re-run on the same day write the same rows again.
//
// The one log line stays, for an incident: Workers Logs is where it is read
// next to everything else that happened.

const DAY_MS = 86_400_000;

// How long a signup_days row is kept: a whole past month, read early in the
// next one, with a few days to spare.
export const SIGNUP_DAYS_KEPT = 40;

export type SignupReport = { created: number; cappedNetworks: number; busiest: number };

export async function reportSignups(
  env: Bindings,
  now: number = Date.now(),
): Promise<SignupReport> {
  // Every claim, tombstones included (usernamesRepo.countCreatedSince).
  const created = await usernamesRepo(env.DIRECTORY_DB).countCreatedSince(now - DAY_MS);

  const today = Math.floor(now / DAY_MS);
  const yesterday = today - 1;
  const days = signupDaysRepo(env.SESSIONS_DB);
  const oldest = today - SIGNUP_DAYS_KEPT;
  const latest = await days.latestDay();
  // From the day after the newest row, but never before the oldest kept day,
  // and always at least yesterday, so a re-run rewrites it.
  const from = Math.min(Math.max(latest === null ? oldest : latest + 1, oldest), yesterday);

  // Each row carries the cap it was counted against, so the two families' caps
  // need no sorting out here, and with both caps off there are no rows to count.
  const totals = new Map(
    (await signupCountsRepo(env.SESSIONS_DB).totalsByDay(from, yesterday)).map((t) => [t.day, t]),
  );
  const caps = signupCapsOf(env);
  const enforced = signupCapEnforcedOf(env);
  const rows: SignupDay[] = [];
  for (let day = from; day <= yesterday; day++) {
    const t = totals.get(day);
    rows.push({
      day,
      cappedNetworks: Number(t?.cappedNetworks ?? 0),
      busiest: Number(t?.busiest ?? 0),
      capIpv4: caps.ipv4,
      capIpv6: caps.ipv6,
      enforced,
    });
  }
  await days.write(rows);

  const { cappedNetworks, busiest } = rows[rows.length - 1] ?? { cappedNetworks: 0, busiest: 0 };
  const mode = enforced ? 'refused' : 'observed, not refused';
  console.log(
    `signups: ${created} accounts in the last 24 h; yesterday ${cappedNetworks} networks went past their daily cap (${mode}) and the busiest network made ${busiest} signups`,
  );
  return { created, cappedNetworks, busiest };
}

// For the daily cron: drop the rows older than SIGNUP_DAYS_KEPT.
export function purgeSignupDays(env: Bindings, now: number = Date.now()): Promise<number> {
  return signupDaysRepo(env.SESSIONS_DB).purgeBefore(Math.floor(now / DAY_MS) - SIGNUP_DAYS_KEPT);
}

import { bytesToHex, CREATE_ACCOUNT_ERROR, utf8 } from '@stxapps/shared';

import { signupCountsRepo } from '../db/repositories/signup-counts';
import type { Bindings } from '../lib/env';
import { HttpError } from '../lib/errors';
import { derivedHmacKey, hmacSecret } from '../r2/hmac-key';

// A daily cap on the accounts one network may create: an IPv4 address, or an IPv6
// /64 (callerNetwork, middleware/rate-limit.ts). It complements the route's
// per-second 'tight' limiter. That one bounds bursts. This one bounds a day's
// volume, which the native binding can't, because its window is 10 s or 60 s.
//
// The cap comes from the env (SIGNUP_CAP_PER_DAY, wrangler.jsonc), and unset means
// off: local dev and the e2e suites create far more accounts from one address than
// any person would.
//
// The count is per UTC calendar day, not a rolling 24 h. One row per (network,
// day) is the whole state, the cron deletes past days, and a refused caller is
// told exactly when it clears.
//
// What is stored is an HMAC of the network, never the network. The key is derived
// from the api's existing secret under its own label (r2/hmac-key.ts), so the
// table can't be read back into addresses without that secret, and the key can't
// be confused with the blob token's or the receipt's.

const DAY_MS = 86_400_000;

const HMAC_INFO = 'bracemark-api signup-cap v1';

// The configured cap, or null when the cap is off. Anything but a positive integer
// is off, so a typo in wrangler.jsonc fails open rather than refusing every signup.
export function signupCapOf(env: Bindings | undefined): number | null {
  const n = Number(env?.SIGNUP_CAP_PER_DAY);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function networkHash(env: Bindings, network: string): Promise<string> {
  const key = await derivedHmacKey(hmacSecret(env), HMAC_INFO);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(network))));
}

// Count this signup against the network's day, and refuse it (429
// `signup_limited`) once the day's cap is spent. Call it after the request has
// proven itself (the signature check) and before anything is provisioned, so a
// malformed request costs no counter write and a refused one costs no account.
//
// A refused attempt still counts. That keeps this to one write with no read
// before it, and a network past its cap stays past it either way.
export async function claimSignupSlot(
  env: Bindings | undefined,
  network: string,
  now: number = Date.now(),
): Promise<void> {
  const cap = signupCapOf(env);
  if (cap === null || !env) return;

  const day = Math.floor(now / DAY_MS);
  const count = await signupCountsRepo(env.SESSIONS_DB).increment(
    await networkHash(env, network),
    day,
  );
  if (count <= cap) return;

  // One line per network per day: the first refusal. The network is logged in
  // the clear, beside the IP the invocation log already holds for every request,
  // so a sustained source can be found and blocked at the edge.
  if (count === cap + 1) console.warn(`signupCap: refused ${network} after ${cap} today`);

  const retryAfterSeconds = Math.ceil(((day + 1) * DAY_MS - now) / 1000);
  throw new HttpError(429, CREATE_ACCOUNT_ERROR.signupLimited, 'Daily signup limit reached', {
    'retry-after': String(retryAfterSeconds),
  });
}

// For the daily cron: drop every day before today. Today's rows stay, so a cron
// run at 03:17 UTC doesn't hand a capped network a fresh allowance.
export function purgeSignupCounts(env: Bindings, now: number = Date.now()): Promise<number> {
  return signupCountsRepo(env.SESSIONS_DB).purgeBefore(Math.floor(now / DAY_MS));
}

import { bytesToHex, CREATE_ACCOUNT_ERROR, isIpv6Network, utf8 } from '@stxapps/shared';

import { signupCountsRepo } from '../db/repositories/signup-counts';
import type { Bindings } from '../lib/env';
import { HttpError } from '../lib/errors';
import { derivedHmacKey, hmacSecret } from '../r2/hmac-key';

// A daily cap on the accounts one network may create: an IPv4 address, or an IPv6
// /64 (callerNetworkKey, lib/network.ts). It complements the route's
// per-second 'tight' limiter. That one bounds bursts. This one bounds a day's
// volume, which the native binding can't, because its window is 10 s or 60 s.
//
// One cap per address family, set to the same number today. Either unit can be
// thousands of people. A shared network (a campus, an office, a venue's wifi) is
// one IPv4 address behind NAT, or one IPv6 /64, since IPv6 gives each device its
// own address but every address on that network shares the /64. Dual-stack
// devices prefer IPv6, so a crowd on such wifi lands in the /64's bucket. The one
// difference runs the other way: a carrier's NAT puts thousands of unrelated
// customers behind one IPv4 address, and IPv6 has no such thing. Nothing in a
// request says how many share it (`request.cf` names the network's owner, not its
// size). Anyone set on making accounts in bulk rotates addresses whatever the
// number is, so the cap is a speed bump, and its real cost is the people it
// refuses by mistake. Two settings rather than one so each family can be tuned
// from the daily report on its own. Anything that isn't a /64
// (isIpv6Network, shared net/ip.ts) takes the IPv4 cap.
//
// The caps come from the env (SIGNUP_CAP_IPV4_PER_DAY, SIGNUP_CAP_IPV6_PER_DAY,
// wrangler.jsonc), each on or off by itself, and unset means off: local dev and
// the e2e suites create far more accounts from one address than any person would.
//
// A HIGH CAP, ENFORCED, AND A REPORT THAT WATCHES FAR BELOW IT. A cap that is on
// counts every signup, but it refuses one only where SIGNUP_CAP_ENFORCE is "1".
// Without it, a network past its cap is logged and let through (observe mode).
// Any fixed number per network is a guess, and a wrong one turns away real people
// on shared wifi without anyone hearing about it. So the deployed caps are set
// far above what a room of people signing up together makes in a day: the cap
// is the hard stop, not the alarm. The alarm is the daily report
// (services/signup-report.ts), whose busiest-network figure shows a source long
// before it reaches the cap. Lower a cap from that figure's history, never on a
// guess. Observe mode stays for a cap that is being tried out.
//
// The count is per UTC calendar day, not a rolling 24 h. One row per (network,
// day) is the whole state, the cron deletes past days, and a refused caller is
// told exactly when it clears.
//
// What is stored is an HMAC of the network, never the network. The key is derived
// from the api's existing secret under its own label (r2/hmac-key.ts), so the
// table can't be read back into addresses without that secret, and the key can't
// be confused with the blob token's or the receipt's. With the secret, an IPv4
// row can be: there are only about four billion addresses to try. So the hash
// keeps addresses out of a dump, and /privacy claims nothing more for it.
//
// ⚠ /privacy depends on the cron dropping past days. The counters are the one
// copy of request data it says we keep ourselves, and it says they are
// short-lived (bracemark-site app/privacy/page.tsx, the carve-out under
// _Technical and security data_ and the counters' line under _How long we keep
// it_). Keeping rows for days past the day they count changes that page first
// (docs/account.md, _creating an account_).

const DAY_MS = 86_400_000;

const HMAC_INFO = 'bracemark-api signup-cap v1';

export type SignupCaps = { ipv4: number | null; ipv6: number | null };

// A configured cap, or null when it is off. Anything but a positive integer is
// off, so a typo in wrangler.jsonc fails open rather than refusing every signup.
function capOf(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function signupCapsOf(env: Bindings | undefined): SignupCaps {
  return {
    ipv4: capOf(env?.SIGNUP_CAP_IPV4_PER_DAY),
    ipv6: capOf(env?.SIGNUP_CAP_IPV6_PER_DAY),
  };
}

// Whether a network past its cap is refused, or only logged and let through.
// Only "1" enforces, so a missing or mistyped value observes: the fail-open
// direction, the same as a mistyped cap.
export function signupCapEnforcedOf(env: Bindings | undefined): boolean {
  return env?.SIGNUP_CAP_ENFORCE === '1';
}

// The cap this network counts against, or null when its family's cap is off.
export function signupCapFor(env: Bindings | undefined, networkKey: string): number | null {
  const caps = signupCapsOf(env);
  return isIpv6Network(networkKey) ? caps.ipv6 : caps.ipv4;
}

async function networkHashOf(env: Bindings, networkKey: string): Promise<string> {
  const key = await derivedHmacKey(hmacSecret(env), HMAC_INFO);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(networkKey))));
}

// Count this signup against the network's day, and once the day's cap is spent,
// refuse it (429 `signup_limited`) where the cap is enforced, or log and admit it
// where it is observed. Call it after the request has proven itself (the
// signature check) and before anything is provisioned, so a malformed request
// costs no counter write and a refused one costs no account.
//
// A refused attempt still counts. That keeps this to one write with no read
// before it, and a network past its cap stays past it either way.
export async function claimSignupSlot(
  env: Bindings | undefined,
  networkKey: string,
  now: number = Date.now(),
): Promise<void> {
  const cap = signupCapFor(env, networkKey);
  if (cap === null || !env) return;

  const day = Math.floor(now / DAY_MS);
  const count = await signupCountsRepo(env.SESSIONS_DB).increment(
    await networkHashOf(env, networkKey),
    day,
    cap,
  );
  if (count <= cap) return;

  // One line per network per day, at the first signup past the cap. The network
  // is logged in the clear, beside the IP the invocation log already holds for
  // every request, so a sustained source can be found and blocked at the edge.
  const enforced = signupCapEnforcedOf(env);
  if (count === cap + 1) {
    console.warn(
      enforced
        ? `signupCap: refused ${networkKey} after ${cap} today`
        : `signupCap: ${networkKey} went past ${cap} today (observing, not refused)`,
    );
  }
  if (!enforced) return;

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

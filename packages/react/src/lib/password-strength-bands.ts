import { PASSWORD_MIN_GUESSES_LOG10 } from '@stxapps/shared';

// The strength meter's BANDS: how a zxcvbn estimate becomes the 0–3 `displayScore`
// both platforms' meters render. Shared for the same reason the message ladders are
// (field-messages.ts): web and native each had their own copy of these thresholds and
// of the banding step, and a band moved on one side would have shown the same
// password as "Fair" on one platform and "Strong" on the other. Only the numbers and
// the words live here. The bar and label colours are per-platform (TONES, beside each
// platform's meter).
//
// zxcvbn's own 0–4 `score` is never used: its top bucket is open-ended (≈ 33 bits), so
// it can't express the gate (web-ui password-strength.tsx, docs/account.md).

// One threshold per band boundary, over the same `guessesLog10` the gate reads, so
// `displayScore` is both the band index and the last segment lit. The top boundary IS
// the gate (PASSWORD_MIN_GUESSES_LOG10), so a full green meter and a passing entropy
// gate are the same condition by construction rather than by clamping.
export const STRENGTH_BANDS = [10, 14, PASSWORD_MIN_GUESSES_LOG10] as const;

// The top `displayScore`, "Strong", which passes the gate. Derived, not written as 3,
// so a band added above can't leave a caller pointing one short of the top. The
// generated passphrase reads as this without being scored (`useNewPassword`).
export const STRONGEST_DISPLAY_SCORE = STRENGTH_BANDS.length;

// One label per `displayScore`, so a full meter reads "Strong" exactly when the gate
// passes. Kept beside the bands because the index is the band: a band added without a
// label would render an empty label at the top (password-strength-bands.spec.ts).
export const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Strong'] as const;

// Band the estimate, then hold it one under the top while the LENGTH floor blocks
// submit. zxcvbn can't be told either floor, so the entropy floor is folded in by the
// top band being the gate, and the length floor has to be applied here; without this
// step a 19-character random password reads "Strong" over a disabled submit.
//
// `length` is the CANONICAL password's, the string the KEK derives from.
export function strengthDisplayScore(
  guessesLog10: number,
  length: number,
  minLength: number,
): number {
  const band = STRENGTH_BANDS.filter((b) => guessesLog10 >= b).length;
  return length < minLength ? Math.min(band, STRONGEST_DISPLAY_SCORE - 1) : band;
}

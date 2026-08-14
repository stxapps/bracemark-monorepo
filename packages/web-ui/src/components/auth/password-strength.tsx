'use client';

import * as React from 'react';

import type { FieldMessage } from '@stxapps/react';
import { PASSWORD_MIN_GUESSES_LOG10 } from '@stxapps/shared';
import { cn } from '@stxapps/web-ui/lib/utils';

// The create-account entropy gate (docs/account.md). Callers gate on the returned
// `guessesLog10` against PASSWORD_MIN_GUESSES_LOG10 (10^18 ≈ 60 bits) on the
// TYPED-your-own path only; the generated passphrase is ~77 bits by construction and
// bypasses this entirely.
//
// zxcvbn's own 0–4 `score` is deliberately NOT surfaced by this module. It's a
// 5-bucket label over the same guess estimate, and its top bucket is open-ended
// ("guesses >= 1e10" ≈ 33 bits) — so score 4 spans `Summer2026Bracemark!` (~35 bits)
// through a 7-word passphrase (~121 bits). Anything a caller could gate on it is
// wrong, so it doesn't leave this file; `displayScore` below is ours, derived from
// the same floors as the gate. See the constant's comment in `shared`
// `auth/credentials.ts`.
//
// zxcvbn is heavy (~400 KB with its dictionaries), so it's DYNAMICALLY imported
// on first use — it never lands in the initial auth-route bundle. Until it loads,
// both outputs are null and the caller keeps submit disabled (never gate-open before
// the estimator is ready).

// Display bands over the same guess estimate the gate uses — one per meter segment,
// so `displayScore` (0–3) is both the band index and the last segment lit. The top
// band IS the gate (PASSWORD_MIN_GUESSES_LOG10), so a full green meter and a passing
// entropy gate are the same condition by construction rather than by clamping.
const DISPLAY_BANDS = [10, 14, PASSWORD_MIN_GUESSES_LOG10];
const TOP_BAND = DISPLAY_BANDS.length; // displayScore 3 = "Strong" = passes the gate

type ScoreFn = (password: string, userInputs: string[]) => number;

// Lazily load zxcvbn + its common language pack once, then score `password`
// (penalizing `userInputs` — e.g. the username — so a username-derived password
// scores low). Returns { guessesLog10: number | null, displayScore: 0–3 | null, ready }.
// Both outputs are null while loading or when the password is empty.
//
// `guessesLog10` is the raw, uncapped estimate — the value callers gate on.
// `displayScore` is for the meter only: a band index derived from BOTH floors the
// gate enforces, so it can never read "Strong" while submit is blocked ("green meter
// but disabled button"). Below `minLength` it's held one band under the top; zxcvbn
// can't be told either floor — it reports estimated guess counts and buckets them —
// so we bucket them ourselves here.
//
// Pass the CANONICAL password so both the length and the estimate match what
// actually derives the KEK.
export function usePasswordStrength(
  password: string,
  userInputs: string[] = [],
  minLength = 0,
): { guessesLog10: number | null; displayScore: number | null; ready: boolean } {
  const [scoreFn, setScoreFn] = React.useState<ScoreFn | null>(null);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const [core, common] = await Promise.all([
        import('@zxcvbn-ts/core'),
        import('@zxcvbn-ts/language-common'),
      ]);
      core.zxcvbnOptions.setOptions({
        dictionary: { ...common.dictionary },
        graphs: common.adjacencyGraphs,
      });
      if (alive) {
        setScoreFn(() => (pw: string, inputs: string[]) => core.zxcvbn(pw, inputs).guessesLog10);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Join userInputs to a stable string key so a fresh [username] array each render
  // doesn't force a recompute when nothing meaningful changed.
  const inputsKey = userInputs.join(' ');
  return React.useMemo(() => {
    if (!scoreFn || !password) {
      return { guessesLog10: null, displayScore: null, ready: scoreFn !== null };
    }
    const guessesLog10 = scoreFn(password, inputsKey ? inputsKey.split(' ').filter(Boolean) : []);
    // Band the estimate, then hold it one under the top while the length floor blocks
    // submit — the entropy floor needs no such step, since the top band IS that floor.
    const band = DISPLAY_BANDS.filter((b) => guessesLog10 >= b).length;
    const displayScore = password.length < minLength ? Math.min(band, TOP_BAND - 1) : band;
    return { guessesLog10, displayScore, ready: true };
  }, [scoreFn, password, inputsKey, minLength]);
}

// The two status pairs the message line and the meter BOTH use, named once because
// they have to match: the message sits directly above the meter's label on the same
// card, so a second amber or a second green there would read as a second meaning.
// Both maps below reference these instead of repeating the strings — which is also
// the answer to why `MESSAGE_TONE` lives in this file rather than beside the ladder
// it serves. It shares its definitions with the meter.
//
// (Both pairs are under 4.5:1 at text-sm in light mode. That floor is one question
// about the app's status colours as a set — these, the bar fills, the amber in
// `ErrorText` — not one to reopen on a single rung.)
const AMBER = 'text-amber-600 dark:text-amber-500';
const EMERALD = 'text-emerald-600 dark:text-emerald-500';

// How a FieldMessage's tone paints on this platform. The WORDS live one layer down in
// `@stxapps/react` (lib/field-messages.ts) so web and native can't drift; only this
// map is platform-specific.
//
// `muted` adds no class where the host element is already muted-foreground (a
// FieldDescription); callers that own a bare <p> add it themselves. `warn` is the
// app's one status-amber — expo's `ErrorText tone="warning"` is the same pair.
export const MESSAGE_TONE: Record<FieldMessage['tone'], string> = {
  error: 'text-destructive',
  warn: AMBER,
  ok: EMERALD,
  muted: '',
};

// One label per band, so a full meter reads "Strong" exactly when the gate passes.
const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong'] as const;

// Bar fill and label share ONE tone per band, so the two halves of the meter can't
// disagree. The top band is GREEN, not `bg-primary`: `--primary` is a neutral
// (oklch(0.205 0 0) light / oklch(0.922 0 0) dark — chroma 0), so a passing meter
// filled black-on-white and white-on-black carried no success signal at all; it read
// as an inert track, and in dark mode a full row of near-white bars is hardest of all
// to tell from the unlit `bg-border` it replaces. Green is what every comment in this
// file already claimed the full meter showed. Raw palette colours here rather than a
// `--color-success` token, matching the `bg-amber-500` status colours elsewhere — and
// note that adding a token would drag `tools/prettier/expo-tailwind.css` in for the
// native twin. The two label colours come from the shared pairs above, so the top
// band and a passing message are one string, not two that agree.
const TONES = [
  { bar: 'bg-destructive', text: 'text-destructive' },
  { bar: 'bg-destructive', text: 'text-destructive' },
  { bar: 'bg-amber-500', text: AMBER },
  { bar: 'bg-emerald-500', text: EMERALD },
] as const;

// A four-segment meter with a text label. Purely presentational — it renders the
// hook's `displayScore` and knows nothing about the policy behind it.
//
// A null score (empty password, or the estimator still loading) renders the EMPTY
// TRACK, not nothing: the meter is a fixed part of the typed-password field, so
// appearing on the first keystroke would shove the message and the helper text below
// it down the card exactly as the user starts typing.
//
// The label slot holds BOTH its axes for that same reason, and each needs its own
// class because an empty label collapses on each independently: `w-16` keeps the
// column (so the bars don't stretch into it), and `min-h-4` keeps the ROW a full
// text-xs line box (1rem) — without it the row is only as tall as the 6px bars while
// the label is empty, and gains 10px the moment a word appears, which is the jump
// this component exists to avoid. `min-h` rather than an `&nbsp;` placeholder: this
// is a live region, so a hard space is real content announced to a screen reader,
// and it's the kind of invisible hack a later edit deletes as a typo.
export function PasswordStrengthMeter({ displayScore }: { displayScore: number | null }) {
  const tone = displayScore === null ? null : TONES[displayScore];
  const filled = displayScore === null ? 0 : displayScore + 1; // displayScore 0 → 1 segment lit

  return (
    <div className="flex items-center gap-2" aria-live="polite">
      <div className="flex flex-1 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn('h-1.5 flex-1 rounded-full', i < filled ? tone?.bar : 'bg-border')}
          />
        ))}
      </div>
      <span className={cn('min-h-4 w-16 shrink-0 text-right text-xs', tone?.text)}>
        {displayScore === null ? '' : LABELS[displayScore]}
      </span>
    </div>
  );
}

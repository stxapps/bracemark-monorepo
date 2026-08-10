'use client';

import * as React from 'react';

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

// One label per band, so a full meter reads "Strong" exactly when the gate passes.
const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong'] as const;

// A four-segment meter with a text label. Purely presentational — it renders the
// hook's `displayScore` and knows nothing about the policy behind it. Renders
// nothing until there's a score to show (empty password / estimator still loading).
export function PasswordStrengthMeter({ displayScore }: { displayScore: number | null }) {
  if (displayScore === null) return null;

  // Segments 1–4 fill as the score climbs (0 fills the first, in red). Color steps
  // destructive → amber → primary; only the top band reads as passing.
  const tone =
    displayScore >= TOP_BAND
      ? 'bg-primary'
      : displayScore === TOP_BAND - 1
        ? 'bg-amber-500'
        : 'bg-destructive';
  const filled = displayScore + 1; // displayScore 0 → 1 segment lit

  return (
    <div className="flex items-center gap-2" aria-live="polite">
      <div className="flex flex-1 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn('h-1.5 flex-1 rounded-full', i < filled ? tone : 'bg-border')}
          />
        ))}
      </div>
      <span
        className={cn(
          'w-16 shrink-0 text-right text-xs',
          displayScore >= TOP_BAND ? 'text-muted-foreground' : 'text-destructive',
        )}
      >
        {LABELS[displayScore]}
      </span>
    </div>
  );
}

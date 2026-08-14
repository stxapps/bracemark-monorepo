import * as React from 'react';
import { View } from 'react-native';

import type { FieldMessage } from '@stxapps/react';
import { PASSWORD_MIN_GUESSES_LOG10 } from '@stxapps/shared';

import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';

// The create-account entropy gate — the native port of web-ui's
// components/auth/password-strength.tsx (see that file for the full rationale:
// why zxcvbn's own 0–4 score never leaves this module, the display bands, and
// the gate/meter agreement invariant). Callers gate on the returned
// `guessesLog10` against PASSWORD_MIN_GUESSES_LOG10 on the TYPED-your-own path
// only; the generated passphrase is ~77 bits by construction and bypasses this.
//
// zxcvbn is heavy (~400 KB with its dictionaries), so it's loaded via a dynamic
// import on first use, same as web. Metro bundles it either way (no code
// splitting on native), but the parse/registration cost still stays off the
// first render. Until it loads, both outputs are null and the caller keeps
// submit disabled (never gate-open before the estimator is ready).

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
// but disabled button"). Below `minLength` it's held one band under the top.
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

// How a FieldMessage's tone paints on this platform. The WORDS live in
// `@stxapps/react` (lib/field-messages.ts), shared with web; only this map is
// platform-specific, and it lives here because its green is the meter's green.
//
// Unlike web, `muted` carries a real class: a native <Text> has no inherited
// muted-foreground to fall back on.
export const MESSAGE_TONE: Record<FieldMessage['tone'], string> = {
  error: 'text-destructive',
  ok: 'text-emerald-600 dark:text-emerald-500',
  muted: 'text-muted-foreground',
};

// One label per band, so a full meter reads "Strong" exactly when the gate passes.
const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong'] as const;

// Bar fill and label share ONE tone per band — see the web twin for why the top band
// is green rather than `bg-primary` (`--primary` is a chroma-0 neutral, so a passing
// meter had no success signal). Raw palette colours, not a new `--color-*` token:
// a token would have to be declared under `@variant light`/`@variant dark` in
// `global.css` AND mirrored into `tools/prettier/expo-tailwind.css`, and this needs
// neither (see the tripwire in CLAUDE.md).
const TONES = [
  { bar: 'bg-destructive', text: 'text-destructive' },
  { bar: 'bg-destructive', text: 'text-destructive' },
  { bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-500' },
  { bar: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-500' },
] as const;

// A four-segment meter with a text label. Purely presentational — it renders the
// hook's `displayScore` and knows nothing about the policy behind it.
//
// A null score (empty password, or the estimator still loading) renders the EMPTY
// TRACK, not nothing, so the meter doesn't shove the message and helper text below it
// down the screen on the first keystroke. The label slot holds BOTH its axes for the
// same reason, and each needs its own class because an empty label collapses on each
// independently: `w-16` keeps the column (so the bars don't stretch into it), and
// `min-h-4` keeps the ROW a full text-xs line box — without it the row is only as tall
// as the 6px bars while the label is empty, and grows the moment a word appears.
export function PasswordStrengthMeter({ displayScore }: { displayScore: number | null }) {
  const tone = displayScore === null ? null : TONES[displayScore];
  const filled = displayScore === null ? 0 : displayScore + 1; // displayScore 0 → 1 segment lit

  return (
    <View className="flex-row items-center gap-2" aria-live="polite">
      <View className="flex-1 flex-row gap-1">
        {[0, 1, 2, 3].map((i) => (
          <View
            key={i}
            className={cn('h-1.5 flex-1 rounded-full', i < filled ? tone?.bar : 'bg-border')}
          />
        ))}
      </View>
      <Text className={cn('min-h-4 w-16 shrink-0 text-right text-xs', tone?.text)}>
        {displayScore === null ? '' : LABELS[displayScore]}
      </Text>
    </View>
  );
}

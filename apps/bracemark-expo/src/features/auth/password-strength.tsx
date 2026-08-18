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
// zxcvbn is heavy (~1.7 MB of raw dictionary JSON), so it's loaded on first use
// rather than at module scope — by a lazy `require()` here where web uses
// `import()`, for the reasons on `loadPasswordScorer` below. Metro bundles it
// either way (no code splitting on native), but the parse/registration cost still
// stays off the first render. Until it loads, both outputs are null and the caller
// keeps submit disabled (never gate-open before the estimator is ready).
//
// BOTH language packs load, matching web exactly — and that identity is the point,
// not a convenience: the gate is policy, so the same typed password must be admitted
// or rejected identically on the two platforms (the same reason the message ladders
// live in `@stxapps/react`). `language-en` is the load-bearing pack; the twin
// explains what it buys, with the measured numbers.
//
// It roughly triples the dictionary payload (~466 KB → ~1.7 MB raw), and native has
// no code splitting to hide that, so it lands in the app bundle. Taken deliberately:
// it is download/disk size, not startup cost (Hermes precompiles to bytecode at build
// time and maps it lazily), and trimming a list on this side only — `lastnames` is
// 695 KB of it — would buy back size by making native's gate weaker than web's, which
// is the one thing this file must not do. The iOS share extension is unaffected: it
// is a separate Metro entry (index.share.js) that never reaches the auth surfaces.

// Display bands over the same guess estimate the gate uses — one per meter segment,
// so `displayScore` (0–3) is both the band index and the last segment lit. The top
// band IS the gate (PASSWORD_MIN_GUESSES_LOG10), so a full green meter and a passing
// entropy gate are the same condition by construction rather than by clamping.
const DISPLAY_BANDS = [10, 14, PASSWORD_MIN_GUESSES_LOG10];
const TOP_BAND = DISPLAY_BANDS.length; // displayScore 3 = "Strong" = passes the gate

type ScoreFn = (password: string, userInputs: string[]) => number;

// Load zxcvbn + both language packs and return the raw scorer — the native twin of
// web-ui's `loadPasswordScorer`, split out for the same reason: which packs are wired
// in is policy, and this platform gets its own spec asserting it matches web's
// (password-strength.spec.ts, both sides).
//
// LAZY `require()`, where web spells the same three loads `import()`. Not a style
// drift — the two runtimes want different things. Web wants a real code-split chunk,
// which only `import()` produces. Metro has no code splitting, so on native `import()`
// buys nothing over `require()` at runtime and costs the module its testability:
// jest's CJS vm cannot service a real dynamic import ("A dynamic import callback was
// invoked without --experimental-vm-modules") and neither babel-preset-expo nor
// @react-native/babel-preset lowers one, so the gate's own spec could not reach it.
// `require()` defers evaluation exactly the same way — the identical trade the iOS
// share path makes for its heavy modules (expo-react data/share-store.ts, which
// explains it at length). Still called from an effect, so the several MB of dictionary
// JSON is not evaluated during the first render of the auth screen.
export function loadPasswordScorer(): ScoreFn {
  const core = require('@zxcvbn-ts/core') as typeof import('@zxcvbn-ts/core');
  const common =
    require('@zxcvbn-ts/language-common') as typeof import('@zxcvbn-ts/language-common');
  const en = require('@zxcvbn-ts/language-en') as typeof import('@zxcvbn-ts/language-en');
  // Disjoint keys, so the spread is a union — see the twin.
  core.zxcvbnOptions.setOptions({
    dictionary: { ...common.dictionary, ...en.dictionary },
    graphs: common.adjacencyGraphs,
  });
  return (pw, inputs) => core.zxcvbn(pw, inputs).guessesLog10;
}

// Lazily load zxcvbn + both language packs once, then score `password`
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

  // In an effect, so the dictionaries are evaluated after the auth screen's first
  // paint rather than during it. No `alive` flag and no promise: the loader is
  // synchronous here (see its note on require-vs-import), so there is no window in
  // which this can resolve against an unmounted component.
  //
  // AND NO FAILURE PATH, which is the one place this hook's surface diverges from
  // web's — web returns a `failed` flag and retries on the next keystroke, and there
  // is nothing here for either to describe. Its `import()` is a network fetch of a
  // code-split chunk, so it can be lost to a dead connection or 404 against a stale
  // build and leave the gate shut for good; this `require()` reads a module out of a
  // bundle Metro already shipped and the OS already installed. If it throws, the
  // dictionaries aren't missing, the app binary is — a red screen, not a field state,
  // and no rung under a password input is the right place to report it. Hence the
  // shared ladder's `strengthFailed` argument is defaulted and left unpassed by this
  // platform (field-messages.ts says the same thing from the other side).
  React.useEffect(() => {
    setScoreFn(() => loadPasswordScorer());
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
// it serves. It shares its definitions with the meter. Same shape as the web twin.
const AMBER = 'text-amber-600 dark:text-amber-500';
const EMERALD = 'text-emerald-600 dark:text-emerald-500';

// How a FieldMessage's tone paints on this platform. The WORDS live in
// `@stxapps/react` (lib/field-messages.ts), shared with web; only this map is
// platform-specific.
//
// Unlike web, `muted` carries a real class: a native <Text> has no inherited
// muted-foreground to fall back on. And `warn` is the same amber as
// `ErrorText tone="warning"`, which is this side's existing name for the same idea
// (proceed-able / not-your-fault, as against `error`).
export const MESSAGE_TONE: Record<FieldMessage['tone'], string> = {
  error: 'text-destructive',
  warn: AMBER,
  ok: EMERALD,
  muted: 'text-muted-foreground',
};

// One label per band, so a full meter reads "Strong" exactly when the gate passes.
const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong'] as const;

// Bar fill and label share ONE tone per band — see the web twin for why the top band
// is green rather than `bg-primary` (`--primary` is a chroma-0 neutral, so a passing
// meter had no success signal). Raw palette colours, not a new `--color-*` token:
// a token would have to be declared under `@variant light`/`@variant dark` in
// `global.css` AND mirrored into `tools/prettier/expo-tailwind.css`, and this needs
// neither (see the tripwire in CLAUDE.md). The two label colours come from the shared
// pairs above, so the top band and a passing message are one string, not two that
// agree.
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
// TRACK, not nothing, so the meter doesn't shove the message and helper text below it
// down the screen on the first keystroke. The label slot holds BOTH its axes for the
// same reason, and each needs its own class because an empty label collapses on each
// independently: `w-16` keeps the column (so the bars don't stretch into it), and
// `min-h-4` keeps the ROW a full text-xs line box — without it the row is only as tall
// as the 6px bars while the label is empty, and grows the moment a word appears.
//
// The `mt-1` is the same OPTICAL correction as the web twin, and carried here for the
// same reason it lives in the component there: both call sites (create-account and
// settings → change password) hang this row directly under a PasswordInput in an 8px
// column, where matching the column's NUMBER reads as too tight. The input's bottom
// border and this row are both full-width, fully inked horizontals, so the channel
// between them reads at exactly its height, while the text gaps around it are padded
// by leading. See the web twin for the measurements. One difference: web's Field kit
// pulls the message up 4px under this row (`nth-last-2:-mt-1` in field.tsx) and
// nothing does that here, so native lands at 17px above / a full 8px below rather
// than 17/9 — still tighter below, which is what keeps meter and message one readout.
export function PasswordStrengthMeter({ displayScore }: { displayScore: number | null }) {
  const tone = displayScore === null ? null : TONES[displayScore];
  const filled = displayScore === null ? 0 : displayScore + 1; // displayScore 0 → 1 segment lit

  return (
    <View className="mt-1 flex-row items-center gap-2" aria-live="polite">
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

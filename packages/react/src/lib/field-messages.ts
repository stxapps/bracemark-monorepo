import {
  type CheckUsernameResponse,
  NEW_PASSWORD_MIN_LENGTH,
  newPasswordSchema,
  PASSWORD_MIN_GUESSES_LOG10,
  usernameSchema,
} from '@stxapps/shared';

// The single message line a credential field keeps under it, in EVERY state — one
// ladder per field, shared by web and native so the same field can't say different
// things on two platforms. Both create-account forms and both Settings → change
// password views read from here.
//
// Why the slot is permanent, and why every rung is filled including the resting one:
//
//   1. No reflow. These states cycle on almost every keystroke (empty → invalid →
//      checking → available; empty → too short → too predictable → strong), and a
//      message that exists in only SOME of them walks the submit button up and down
//      the form under the user's hands.
//   2. It forces the states to be exhaustive. A conditional message gets written for
//      the cases someone thought of and its gaps are invisible: the chain this
//      replaced printed NOTHING for a username the server reported taken, and nothing
//      for a valid-length password while zxcvbn was still loading — both times leaving
//      submit disabled with no reason given. A slot that must always say something
//      turns a missing state into missing code.
//
// These are ladders, not lookups: order is significance, most specific first. And each
// string must fit ONE line in the slot — a message that wraps to two reintroduces the
// jump the slot exists to remove, just a smaller one.
//
// Budget the width against a PHONE, not the card's maximum. Web's auth card is
// `max-w-sm`, so the slot is 334px only once the viewport clears ~430px; below that it
// tracks the viewport — measured at 293px in a 390px window and 223px at 320px, and
// native is narrower still. ~220px is the honest ceiling, which is roughly 33
// characters at text-sm. The rung this note was written under ("Looks strong — save it
// in your password manager.", 334px) passed the old ~335px reading of the rule by a
// single pixel and wrapped on every phone.
//
// Only the WORDS live here. The tone→class map is per-platform (MESSAGE_TONE, beside
// each platform's strength meter, which shares the same green).
//
// The tone is read as two separate things by every caller, and they are NOT a severity
// scale — keep them straight before adding a rung:
//
//   ok     THE GATE. Both forms spell Continue as `tone === 'ok'`, so every other tone
//          blocks. Nothing else grants passage.
//   error  THE VERDICT. Both forms spell `aria-invalid` / `data-invalid` as
//          `tone === 'error'` — a claim to assistive tech that the value the user TYPED
//          is rejected ("Username, invalid entry"), plus the destructive border. Only
//          use it when that claim is true.
//   warn   Blocks WITHOUT that claim. For when the check itself failed rather than the
//          value: we can't accept the name, but nothing is wrong with it and editing it
//          won't help. Calling that `error` would announce "invalid entry" about a name
//          that may be perfectly free and point the user at the one repair that fixes
//          nothing — while leaving it `muted` makes a stuck state look exactly like the
//          two rungs that resolve themselves.
//   muted  Resting or in-flight. Blocked, but self-resolving, so no emphasis is owed.
export type FieldMessage = { text: string; tone: 'error' | 'warn' | 'ok' | 'muted' };

// The shape `useUsernameAvailable` returns, narrowed to what the ladder reads. Kept
// structural rather than importing the query type so this file stays a pure function
// over plain data.
export type UsernameAvailability = {
  current: boolean;
  isFetching: boolean;
  isError: boolean;
  data?: CheckUsernameResponse;
};

// The message under the create-account username field.
//
// `takenOnSubmit` is the flag set when account creation itself came back with
// UsernameTakenError — the server's authoritative answer, which outranks anything the
// live query has cached, so it leads the ladder.
//
// `availability.current` guards BOTH verdicts, and it's the reason this can't be a
// plain read of `data`. The query answers the DEBOUNCED name, so for ~400ms after a
// keystroke its data describes the name as it was before — while `isFetching` is still
// false, because no request is in flight yet. "Username is available" about a name the
// user has already typed past is the one direction this line must never be wrong in;
// not-current reads as "checking", which is simply true.
export function usernameMessage(
  username: string,
  availability: UsernameAvailability,
  takenOnSubmit: boolean,
): FieldMessage {
  const parse = usernameSchema.safeParse(username);
  return takenOnSubmit
    ? { text: 'Username is taken', tone: 'error' }
    : username === ''
      ? // Spelling the charset out ("letters, numbers, or underscores") ran 257px and
        // wrapped below a ~430px viewport. `_` is the character itself, which is what
        // the rule is about, and it survives the width budget at 176px.
        { text: '3–32 letters, numbers, or _', tone: 'muted' }
      : !parse.success
        ? // Reuse the schema's own message so the rule that actually failed (length,
          // charset, or reserved name) shows through instead of one catch-all string.
          { text: parse.error?.issues[0]?.message ?? 'Invalid username', tone: 'error' }
        : !availability.current || availability.isFetching
          ? { text: 'Checking availability…', tone: 'muted' }
          : availability.data?.available === true
            ? { text: 'Username is available', tone: 'ok' }
            : availability.data?.available === false
              ? { text: 'Username is taken', tone: 'error' }
              : availability.isError
                ? // The request FAILED — offline, server down, non-2xx. This is the one
                  // rung that is STUCK: nothing about it resolves on its own, and editing
                  // the name won't help, so it owes the user both an emphasis and an
                  // instruction. `warn` and not `error` because the typed name isn't
                  // what's rejected — `error` is wired to `aria-invalid` in both forms,
                  // and announcing "invalid entry" about a name that may be perfectly
                  // free points at the one repair that fixes nothing. The words name the
                  // CHECK, not the name, for the same reason.
                  //
                  // Both halves survive the width budget, and both had to: the old
                  // wording ("Could not check that name. Try again in a moment.") was
                  // the widest string either ladder could print at 337px, wrapping to
                  // two lines below a ~500px viewport. Shortening to just the subject
                  // was tempting and wrong — the instruction is the half this rung owes,
                  // per the paragraph above. 173px.
                  { text: "Couldn't check. Try again.", tone: 'warn' }
                : // No data and no error: the query is enabled but hasn't settled — the
                  // frame between mount and fetch start, or a request aborted by a newer
                  // keystroke (`signal`), both of which leave `isFetching` false for a
                  // tick with nothing yet to report. Self-resolving, so it says exactly
                  // what the debounce rung above says: this is the same "wait", reached
                  // a different way, and it must not look stuck.
                  //
                  // Note this branch is NOT the query being disabled. `enabled` gates on
                  // the CANONICAL name while the !parse.success rung gates on the RAW
                  // one, but the two can't disagree: the schema's charset is ASCII-only
                  // and its reserved check canonicalizes internally, so trim→NFKC→
                  // lowercase is identity on anything that already parsed. A raw pass is
                  // a canonical pass, so a disabled query can only ever sit behind that
                  // invalid-format rung, never fall through to here.
                  { text: 'Checking availability…', tone: 'muted' };
}

// The message under a NEW-password field — create-account and change-password alike.
//
// Pass the RAW password (the schema trims for itself) and the `guessesLog10` scored
// from the CANONICAL one, which is what usePasswordStrength wants anyway.
export function newPasswordMessage(password: string, guessesLog10: number | null): FieldMessage {
  const parse = newPasswordSchema.safeParse(password);
  // Length first — the schema owns its own message, and that message is now the SAME
  // sentence as the resting rung below, so an empty field and a too-short one state one
  // rule in one voice — then the entropy floor, otherwise
  // a long-but-predictable password fails with a silent "Fair" meter and no way to know
  // what to change. The `guessesLog10 === null` rung is the estimator still loading:
  // submit is disabled through that window too, so it has to say so rather than sit
  // blank and look like it passed.
  return password === ''
    ? { text: `At least ${NEW_PASSWORD_MIN_LENGTH} characters.`, tone: 'muted' }
    : !parse.success
      ? { text: parse.error?.issues[0]?.message ?? 'Invalid password', tone: 'error' }
      : guessesLog10 === null
        ? { text: 'Checking strength…', tone: 'muted' }
        : guessesLog10 < PASSWORD_MIN_GUESSES_LOG10
          ? // The FIX, not the diagnosis. "Too predictable — add a few more words." ran
            // 276px and wrapped on every phone, and the half worth keeping is the half
            // the user can act on: the meter directly above is already showing red at
            // "Very weak"/"Weak", which is the verdict this dropped.
            { text: 'Add a few more words.', tone: 'error' }
          : // The passing rung says what the METER CAN'T. Every one of the four callers
            // renders PasswordStrengthMeter directly above this line, and the meter's
            // own label is the verdict — so "Looks strong" here was the same word in the
            // same green 13px apart, and the meter row is the `aria-live` one, so a
            // screen reader heard the verdict from it either way. Worse, doubling it
            // overclaims: zxcvbn is a weakness detector, not a strength certificate
            // (docs/account.md), and the banded meter is the hedged form of that reading
            // — a sentence agreeing with it reads as a second, more confident source.
            // What's left for this line is the one thing nothing else on the field says:
            // save it.
            //
            // NOT "in your password manager", which was the old wording. It names a tool
            // instead of the outcome, and "your" presumes one — a user without a manager
            // is told to use a thing they don't have at the moment they most need to act,
            // and the app's own answer is broader anyway (the marketing site's FAQ,
            // _where should I keep my passphrase_: a manager is best, a notes app that
            // locks or paper both work). It was also least apt HERE, since this rung only
            // shows on the typed-your-own path; the generated path's helper text is where
            // that advice belongs. "Somewhere safe" is the phrase the rest of the app
            // already uses — both ShowOnceSecret confirm labels, all the recovery-code
            // copy — so this stops being the one surface that says it differently.
            //
            // The why is deliberately not repeated: this step's header ("no password
            // reset — your password is the key to your links") and the helper paragraph
            // under this very field both carry it. Adding a clause here would be a third
            // telling AND would wrap on a phone (see the width budget above).
            { text: 'Save it somewhere safe.', tone: 'ok' };
}

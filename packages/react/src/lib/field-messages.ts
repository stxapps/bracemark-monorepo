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
// string must fit ONE line at card width on the narrowest surface (~335px on web's
// auth card) — a message that wraps to two reintroduces the jump the slot exists to
// remove, just a smaller one.
//
// Only the WORDS live here. The tone→class map is per-platform (MESSAGE_TONE, beside
// each platform's strength meter, which shares the same green).
export type FieldMessage = { text: string; tone: 'error' | 'ok' | 'muted' };

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
      ? { text: '3–32 letters, numbers, or underscores.', tone: 'muted' }
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
              : { text: 'Could not check that name. Try again in a moment.', tone: 'muted' };
}

// The message under a NEW-password field — create-account and change-password alike.
//
// Pass the RAW password (the schema trims for itself) and the `guessesLog10` scored
// from the CANONICAL one, which is what usePasswordStrength wants anyway.
export function newPasswordMessage(password: string, guessesLog10: number | null): FieldMessage {
  const parse = newPasswordSchema.safeParse(password);
  // Length first — the schema owns its own message — then the entropy floor, otherwise
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
          ? { text: 'Too predictable — add a few more words.', tone: 'error' }
          : { text: 'Looks strong — save it in your password manager.', tone: 'ok' };
}

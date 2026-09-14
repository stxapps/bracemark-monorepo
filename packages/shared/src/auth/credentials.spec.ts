import { generateRecoveryCode } from '../crypto/recovery-code';
import type { z } from '../zod';
import {
  createAccountSchema,
  lockPasswordSchema,
  NEW_PASSWORD_MIN_LENGTH,
  newPasswordSchema,
  PASSWORD_MIN_GUESSES_LOG10,
  passwordSchema,
  recoveryCodeSchema,
  recoverySignInSchema,
  RESERVED_USERNAMES,
  signInSchema,
  usernameSchema,
} from './credentials';

// Two length schemas on purpose (docs/account.md — "password — rules and
// entropy"): sign-in stays permissive so it never strands a valid account;
// create/change enforces the policy floor. These specs pin that split.
describe('passwordSchema (sign-in — permissive)', () => {
  it('accepts an 8-char password (the loose sign-in floor)', () => {
    expect(passwordSchema.safeParse('abcdefgh').success).toBe(true);
  });

  it('measures the TRIMMED length (whitespace-only fails min)', () => {
    expect(passwordSchema.safeParse('        ').success).toBe(false);
  });

  it('trims surrounding whitespace from the parsed value', () => {
    expect(passwordSchema.parse('  abcdefgh  ')).toBe('abcdefgh');
  });
});

describe('newPasswordSchema (create / change — policy floor)', () => {
  it('rejects a password shorter than the 20-char floor', () => {
    expect(newPasswordSchema.safeParse('abcdefghijklmnopqrs').success).toBe(false); // 19
  });

  it('accepts a password at the floor', () => {
    expect(newPasswordSchema.safeParse('abcdefghijklmnopqrst').success).toBe(true); // 20
  });

  it('is stricter than sign-in: an 8-char password passes sign-in but not create', () => {
    const pw = 'abcdefgh';
    expect(passwordSchema.safeParse(pw).success).toBe(true);
    expect(newPasswordSchema.safeParse(pw).success).toBe(false);
  });

  it('measures the TRIMMED length against the floor', () => {
    // 20 visible chars + surrounding spaces still passes; 19 + padding does not.
    expect(newPasswordSchema.safeParse('  abcdefghijklmnopqrst  ').success).toBe(true);
    expect(newPasswordSchema.safeParse('  abcdefghijklmnopqrs  ').success).toBe(false);
  });

  it('rejects passwords over the 128-char Argon2id bound', () => {
    expect(newPasswordSchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(newPasswordSchema.safeParse('a'.repeat(128)).success).toBe(true);
  });

  it('exposes the floor as a shared constant', () => {
    expect(NEW_PASSWORD_MIN_LENGTH).toBe(20);
  });

  // The two floors are one policy: zxcvbn models an unmatched password as 10^length
  // guesses, so the entropy gate already implies ~19 chars. If someone lowers the
  // length floor below that, the length rule silently stops being the backstop it's
  // documented to be (a shorter password would fail on entropy with a vaguer message).
  it('keeps the length floor consistent with the entropy floor', () => {
    expect(NEW_PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(PASSWORD_MIN_GUESSES_LOG10);
  });
});

// The same permissive-on-purpose split as passwordSchema above, one notch further:
// this is the door for a user whose password is already gone, so the schema only
// pre-filters empty input and leaves every judgement about the code itself to the
// GCM tag at unwrap time.
describe('recoveryCodeSchema (recovery sign-in — permissive)', () => {
  it('accepts a generated code in its displayed, hyphenated form', () => {
    expect(recoveryCodeSchema.safeParse(generateRecoveryCode()).success).toBe(true);
  });

  it('accepts a code typed without the display grouping, in any case', () => {
    const canonical = generateRecoveryCode().replace(/-/g, '');
    expect(recoveryCodeSchema.safeParse(canonical.toLowerCase()).success).toBe(true);
  });

  it('rejects input with no code characters left after normalizing', () => {
    for (const v of ['', '   ', '-- --']) {
      expect(recoveryCodeSchema.safeParse(v).success).toBe(false);
    }
  });

  it('does NOT enforce the canonical 52-char length — the GCM tag is the real check', () => {
    expect(recoveryCodeSchema.safeParse('ABC12').success).toBe(true);
  });

  it('bounds a paste accident at 256 characters', () => {
    expect(recoveryCodeSchema.safeParse('A'.repeat(256)).success).toBe(true);
    expect(recoveryCodeSchema.safeParse('A'.repeat(257)).success).toBe(false);
  });
});

// `usernameSchema` is not only the form's rule — it backs every auth endpoint's
// payload (endpoints.ts), so it is the SERVER's gate on the handle too, and it
// runs before the directory claim. The blocklist below was the only part pinned.
describe('usernameSchema (length + handle grammar)', () => {
  it('accepts the shortest and longest allowed handles', () => {
    expect(usernameSchema.safeParse('abc').success).toBe(true); // 3
    expect(usernameSchema.safeParse('a'.repeat(32)).success).toBe(true); // 32
  });

  it('rejects one character either side of the bounds', () => {
    expect(usernameSchema.safeParse('ab').success).toBe(false); // 2
    expect(usernameSchema.safeParse('a'.repeat(33)).success).toBe(false); // 33
  });

  it('allows alphanumeric groups separated by a single underscore or hyphen', () => {
    for (const u of ['alice_01', 'alice-01', 'ALICE', 'abc', '000']) {
      expect(usernameSchema.safeParse(u).success).toBe(true);
    }
  });

  it('rejects characters outside the ASCII handle set', () => {
    for (const u of ['alice.01', 'alice 01', 'alice@01', 'alicé']) {
      expect(usernameSchema.safeParse(u).success).toBe(false);
    }
  });

  it('rejects leading, trailing and repeated separators', () => {
    for (const u of [
      '_alice',
      'alice_',
      '-alice',
      'alice-',
      'alice__01',
      'alice--01',
      'alice_-01',
      'alice-_01',
      '___',
      '---',
    ]) {
      expect(usernameSchema.safeParse(u).success).toBe(false);
    }
  });

  it('measures the TRIMMED handle and yields the trimmed value', () => {
    // The parsed value is what the payload carries to the server, which stores
    // its canonical form as the unique handle — padding must never reach it.
    expect(usernameSchema.parse('  alice_01  ')).toBe('alice_01');
    expect(usernameSchema.safeParse('  ab  ').success).toBe(false); // trims to 2
  });
});

describe('usernameSchema (reserved-name blocklist)', () => {
  it('accepts an ordinary username', () => {
    expect(usernameSchema.safeParse('alice_01').success).toBe(true);
  });

  it('rejects a reserved name', () => {
    const r = usernameSchema.safeParse('admin');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('This username is reserved');
  });

  it('blocks reserved names regardless of case or surrounding whitespace', () => {
    for (const u of ['ADMIN', 'Admin', '  admin  ', 'Support', 'BRACE']) {
      expect(usernameSchema.safeParse(u).success).toBe(false);
    }
  });

  it('only blocks EXACT reserved handles, not substrings', () => {
    for (const u of ['admin123', 'notadmin', 'supporter', 'brace_fan']) {
      expect(usernameSchema.safeParse(u).success).toBe(true);
    }
  });

  it('every reserved entry is itself handle-valid and ≥3 chars (no dead entries)', () => {
    for (const name of RESERVED_USERNAMES) {
      // Would a real user typing this exact handle be blocked? Only if the entry
      // could pass the length+handle-grammar rules to begin with.
      expect(name).toMatch(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/);
      expect(name.length).toBeGreaterThanOrEqual(3);
      expect(name.length).toBeLessThanOrEqual(32);
    }
  });
});

// A lock gates already-decrypted local data; the verifier PBKDF2s the password
// bytes exactly as given (web-crypto/expo-crypto lock-verifier.ts — no
// canonicalization, unlike the account password's trim + NFC), and the lock
// dialog hashes this schema's PARSED value. So the absence of `.trim()` here is
// load-bearing, not an oversight.
describe('lockPasswordSchema (device-local app/list locks)', () => {
  it('accepts any non-empty password — no policy floor', () => {
    expect(lockPasswordSchema.safeParse('a').success).toBe(true);
    expect(lockPasswordSchema.safeParse('1234').success).toBe(true);
  });

  it('rejects an empty password', () => {
    expect(lockPasswordSchema.safeParse('').success).toBe(false);
  });

  it('keeps the same 128-char ceiling as the account password', () => {
    expect(lockPasswordSchema.safeParse('a'.repeat(128)).success).toBe(true);
    expect(lockPasswordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  it('does NOT trim — the verifier hashes the bytes as typed', () => {
    // Adding `.trim()` here "for consistency" with passwordSchema would lock out
    // every existing lock whose password has leading or trailing space: the
    // verifier stored a hash of the padded bytes and would now be handed the
    // trimmed ones. Nothing else in the workspace would fail.
    expect(lockPasswordSchema.parse('  pw  ')).toBe('  pw  ');
    expect(lockPasswordSchema.safeParse('   ').success).toBe(true);
  });
});

// Which password rule each FORM is wired to is its own fact: the field schemas
// above are pinned individually, but nothing checked that create-account got the
// strict one and sign-in the permissive one. Swapping them is a one-token edit
// that types and lints clean, and fails in opposite, equally bad directions —
// weak passwords admitted at create, or valid accounts locked out at sign-in.
describe('the composed form schemas', () => {
  const strongEnough = 'a'.repeat(NEW_PASSWORD_MIN_LENGTH);
  const eightChars = 'abcdefgh';

  it('wires create-account to the POLICY floor', () => {
    expect(createAccountSchema.safeParse({ username: 'alice', password: eightChars }).success).toBe(
      false,
    );
    expect(
      createAccountSchema.safeParse({ username: 'alice', password: strongEnough }).success,
    ).toBe(true);
  });

  it('wires sign-in to the PERMISSIVE floor, so a short old password still submits', () => {
    expect(signInSchema.safeParse({ username: 'alice', password: eightChars }).success).toBe(true);
  });

  it('applies the username rules on every form, including the recovery door', () => {
    expect(signInSchema.safeParse({ username: 'ad min', password: eightChars }).success).toBe(
      false,
    );
    expect(
      createAccountSchema.safeParse({ username: 'admin', password: strongEnough }).success,
    ).toBe(false);
    expect(
      recoverySignInSchema.safeParse({ username: 'admin', recoveryCode: generateRecoveryCode() })
        .success,
    ).toBe(false);
  });

  it('accepts a well-formed recovery sign-in and rejects an empty code', () => {
    const username = 'alice';
    expect(
      recoverySignInSchema.safeParse({ username, recoveryCode: generateRecoveryCode() }).success,
    ).toBe(true);
    expect(recoverySignInSchema.safeParse({ username, recoveryCode: '' }).success).toBe(false);
  });
});

// The width budget the source comment spells out and then says nothing enforces:
// these messages render into a one-line slot under the field — ~223px on web at a
// 320px viewport, ~185px effective on native at 1.3x text — so past roughly 33
// characters they wrap and walk the submit button down the form. It lints, types
// and tests clean; the symptom only shows on a phone. This is the enforcement.
describe('the field messages fit their one-line slot', () => {
  const MESSAGE_BUDGET = 33;

  // Every rule that can produce a message, driven by an input that trips it.
  const cases: [string, z.ZodType, unknown][] = [
    ['username too short', usernameSchema, 'ab'],
    ['username too long', usernameSchema, 'a'.repeat(33)],
    ['username charset', usernameSchema, 'alice.01'],
    ['username separator placement', usernameSchema, 'alice--01'],
    ['username reserved', usernameSchema, 'admin'],
    ['password too short', passwordSchema, 'abc'],
    ['password too long', passwordSchema, 'a'.repeat(129)],
    ['new password too short', newPasswordSchema, 'abc'],
    ['new password too long', newPasswordSchema, 'a'.repeat(129)],
    ['lock password empty', lockPasswordSchema, ''],
    ['lock password too long', lockPasswordSchema, 'a'.repeat(129)],
    ['recovery code empty', recoveryCodeSchema, ''],
    ['recovery code too long', recoveryCodeSchema, 'A'.repeat(257)],
  ];

  it.each(cases)('%s', (_name, schema, input) => {
    const result = schema.safeParse(input);

    expect(result.success).toBe(false); // the case must actually trip its rule
    if (result.success) return;
    for (const issue of result.error.issues) {
      expect(issue.message.length).toBeLessThanOrEqual(MESSAGE_BUDGET);
      // A raw zod default ("String must contain at least 3 character(s)") is both
      // over budget and in the wrong voice — every rule here carries its own.
      expect(issue.message).not.toMatch(/^Invalid|^String must/);
    }
  });
});

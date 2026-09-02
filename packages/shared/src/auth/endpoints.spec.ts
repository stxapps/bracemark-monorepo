import type { z } from '../zod';
import {
  changePasswordPayloadSchema,
  createAccountPayloadSchema,
  deleteAccountPayloadSchema,
  putRecoveryDoorPayloadSchema,
  signInPayloadSchema,
  wireDoorSchema,
} from './endpoints';

// The signed payloads are the only part of this file with runtime behavior worth
// pinning here (the endpoint descriptors are compile-time, and the request/response
// schemas are driven end-to-end by bracemark-api's route specs).
//
// What no route spec asserts is the property the comments claim repeatedly — that
// `action` makes each proof unusable as any other. It carries the whole weight:
// signInPayloadSchema and deleteAccountPayloadSchema have IDENTICAL field sets, and
// zod strips unknown keys, so change-password's extra `passwordDoor` does not stop
// its payload parsing as a delete-account one either. Only the literal separates a
// "prove you can sign in" signature from a "tear this account down" signature.
// bracemark-api's auth.spec.ts covers two of these pairs at the route layer; this is
// the full matrix, at the layer that owns the rule.

const door = { wrappedDek: 'cd'.repeat(48), iv: 'ef'.repeat(12) };
const base = { username: 'alice', publicKey: 'ab'.repeat(32), timestamp: 1_700_000_000_000 };

const payloads: [string, z.ZodType, Record<string, unknown>][] = [
  [
    'create-account',
    createAccountPayloadSchema,
    { action: 'create-account', ...base, passwordDoor: door },
  ],
  ['sign-in', signInPayloadSchema, { action: 'sign-in', ...base }],
  ['delete-account', deleteAccountPayloadSchema, { action: 'delete-account', ...base }],
  [
    'change-password',
    changePasswordPayloadSchema,
    { action: 'change-password', ...base, passwordDoor: door },
  ],
  [
    'put-recovery-door',
    putRecoveryDoorPayloadSchema,
    { action: 'put-recovery-door', ...base, recoveryDoor: door },
  ],
];

describe('the signed auth payloads', () => {
  // Without this the matrix below could pass while every payload was malformed.
  it.each(payloads)('%s accepts its own payload', (_name, schema, payload) => {
    expect(schema.safeParse(payload).success).toBe(true);
  });

  it('refuses every OTHER action’s payload', () => {
    for (const [name, schema] of payloads) {
      for (const [otherName, , otherPayload] of payloads) {
        if (otherName === name) continue;
        const result = schema.safeParse(otherPayload);
        expect({ schema: name, payload: otherName, accepted: result.success }).toEqual({
          schema: name,
          payload: otherName,
          accepted: false,
        });
      }
    }
  });

  it('lets create-account omit the recovery door, but not malform it', () => {
    // The ceremony is skippable (docs/account.md) — an account may start with a
    // password door only.
    const withoutRecovery = { action: 'create-account' as const, ...base, passwordDoor: door };
    expect(createAccountPayloadSchema.safeParse(withoutRecovery).success).toBe(true);
    expect(
      createAccountPayloadSchema.safeParse({ ...withoutRecovery, recoveryDoor: {} }).success,
    ).toBe(false);
  });
});

// Pinning exact lengths is what makes a malformed key or blob a clean 400 at the
// contract boundary instead of a crash deeper in — the wrapped-door lengths are
// fixed by the algorithm (a 32-byte DEK under AES-256-GCM is always 48 bytes out,
// with a 12-byte IV), so anything else is a client bug, not a variant.
describe('the hex wire fields', () => {
  it('accepts a well-formed door', () => {
    expect(wireDoorSchema.safeParse(door).success).toBe(true);
  });

  it('rejects a door that is one nibble off in either direction', () => {
    expect(wireDoorSchema.safeParse({ ...door, wrappedDek: 'c'.repeat(95) }).success).toBe(false);
    expect(wireDoorSchema.safeParse({ ...door, wrappedDek: 'c'.repeat(97) }).success).toBe(false);
    expect(wireDoorSchema.safeParse({ ...door, iv: 'e'.repeat(23) }).success).toBe(false);
  });

  it('rejects non-hex and UPPERCASE hex — one spelling per byte string', () => {
    expect(wireDoorSchema.safeParse({ ...door, iv: 'EF'.repeat(12) }).success).toBe(false);
    expect(wireDoorSchema.safeParse({ ...door, iv: 'gg'.repeat(12) }).success).toBe(false);
  });

  it('rejects a signing key of the wrong length', () => {
    expect(signInPayloadSchema.safeParse({ ...base, action: 'sign-in' }).success).toBe(true);
    for (const publicKey of ['ab'.repeat(31), 'ab'.repeat(33), '']) {
      expect(signInPayloadSchema.safeParse({ ...base, action: 'sign-in', publicKey }).success).toBe(
        false,
      );
    }
  });

  it('requires an integer timestamp', () => {
    expect(
      signInPayloadSchema.safeParse({ ...base, action: 'sign-in', timestamp: 1.5 }).success,
    ).toBe(false);
  });
});

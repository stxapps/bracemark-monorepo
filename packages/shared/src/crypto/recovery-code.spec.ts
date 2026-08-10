import { generateRecoveryCode, normalizeRecoveryCode, RECOVERY_CODE_BYTES } from './recovery-code';

describe('generateRecoveryCode', () => {
  it('produces a grouped Crockford code with no ambiguous chars', () => {
    const code = generateRecoveryCode();
    // Groups of 5 joined by hyphens; only Crockford alphabet (no I L O U).
    expect(code).toMatch(/^[0-9A-TV-Z]{5}(-[0-9A-TV-Z]{1,5})*$/);
    expect(code).not.toMatch(/[ILOU]/);
  });

  it('carries the full 256-bit entropy (52 base32 chars for 32 bytes)', () => {
    expect(RECOVERY_CODE_BYTES).toBe(32);
    expect(normalizeRecoveryCode(generateRecoveryCode())).toHaveLength(52);
  });

  it('does not repeat across calls', () => {
    expect(generateRecoveryCode()).not.toEqual(generateRecoveryCode());
  });
});

describe('normalizeRecoveryCode', () => {
  it('strips grouping and is unchanged by a round-trip of a generated code', () => {
    const code = generateRecoveryCode();
    const canonical = normalizeRecoveryCode(code);
    expect(canonical).not.toContain('-');
    // Re-normalizing the canonical form is a no-op (idempotent).
    expect(normalizeRecoveryCode(canonical)).toBe(canonical);
  });

  it('repairs the confusables a human might type (o→0, i/l→1) and lowercases', () => {
    expect(normalizeRecoveryCode('oil-OIL abc')).toBe('011011ABC');
  });
});

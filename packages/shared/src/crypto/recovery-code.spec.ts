import { CRYPTO_CONTRACT_VECTOR } from './contract-vectors';
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

  it('groups 52 chars as ten blocks of five plus a tail of two', () => {
    // The display form is what a user writes down and transcribes back, so its
    // shape is a product decision, not an implementation detail.
    const groups = generateRecoveryCode().split('-');
    expect(groups).toHaveLength(11);
    expect(groups.slice(0, 10).map((g) => g.length)).toEqual(Array(10).fill(5));
    expect(groups[10]).toHaveLength(2);
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

  it('leaves a GENERATED code untouched apart from the grouping', () => {
    // The confusable repair rewrites O, I and L — characters Crockford's alphabet
    // never emits. That is the whole reason it is safe to apply unconditionally,
    // and it is an assumption about the ENCODER, not about this function: if
    // @scure/base ever emitted an I, this repair would corrupt real codes into
    // KEKs that cannot open the door. 40 draws covers the alphabet many times over.
    for (let i = 0; i < 40; i++) {
      const code = generateRecoveryCode();
      expect(normalizeRecoveryCode(code)).toBe(code.replace(/-/g, ''));
    }
  });

  it('recovers the canonical form of the frozen contract vector', () => {
    // The recovery KEK is HKDF over the utf8 bytes of THIS string, so the vector's
    // code must already be canonical and must survive normalization unchanged —
    // otherwise every recovery door minted against it opens with different bytes.
    const { code } = CRYPTO_CONTRACT_VECTOR.recovery;
    expect(normalizeRecoveryCode(code)).toBe(code);
    expect(code).toHaveLength(52);
  });

  it('survives a paste with newlines, spaces and stray punctuation', () => {
    const code = generateRecoveryCode();
    const pasted = `\n  ${code.replace(/-/g, ' — ')}\t `;
    expect(normalizeRecoveryCode(pasted)).toBe(normalizeRecoveryCode(code));
  });
});

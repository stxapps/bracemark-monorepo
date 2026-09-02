import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  bytesToUtf8,
  hexToBytes,
  utf8,
} from './encoding';

// The hex pair is how ALL crypto material crosses a JSON request — a wrapped DEK,
// a public key, a signature — and it is the form `hexBytes()` in auth/endpoints.ts
// validates on the way in. It was the one pair here with no spec of its own.
describe('bytesToHex / hexToBytes', () => {
  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it('emits lowercase, two zero-padded chars per byte — the wire form', () => {
    // `hexBytes()` matches /^[0-9a-f]{n}$/, so an uppercase or unpadded encoder
    // would produce values the contract rejects at its own boundary.
    expect(bytesToHex(new Uint8Array([0x00, 0x0f, 0xa0, 0xff]))).toBe('000fa0ff');
    expect(bytesToHex(new Uint8Array())).toBe('');
  });

  it('accepts uppercase hex on the way back in', () => {
    // Deliberately asymmetric: we only ever EMIT lowercase, but a value that
    // reached us in the other case still decodes rather than silently zeroing.
    expect(hexToBytes('DEADBEEF')).toEqual(hexToBytes('deadbeef'));
  });

  it('does NOT validate — malformed hex decodes to something plausible', () => {
    // The sharp edge worth knowing about: `parseInt` yields NaN for a non-hex
    // pair and a Uint8Array store coerces that to 0, and an odd-length string
    // truncates rather than throwing. So a corrupt field becomes a WRONG KEY, not
    // an error, and surfaces much later as a GCM "tampered" failure. Validation
    // is the caller's job and it already exists at the wire boundary
    // (`hexBytes()` in auth/endpoints.ts, exact length + lowercase only) — do not
    // read this function as a second line of defence.
    expect(hexToBytes('zzzz')).toEqual(new Uint8Array([0, 0]));
    expect(hexToBytes('abc')).toEqual(new Uint8Array([0xab])); // trailing nibble dropped
  });
});

// utf8 is the text→bytes step for every crypto input: the signed payloads, the
// HKDF labels, the recovery code's KEK material. A wrong encoding there is a wrong
// key, so the multi-byte cases matter more than the ASCII ones.
describe('utf8 / bytesToUtf8', () => {
  it('round-trips text beyond ASCII', () => {
    for (const text of ['bracemark', 'café', '🔐 clé', 'e\u0301 vs é']) {
      expect(bytesToUtf8(utf8(text))).toBe(text);
    }
  });

  it('encodes to UTF-8 byte lengths, not code-unit counts', () => {
    expect(utf8('a')).toHaveLength(1);
    expect(utf8('é')).toHaveLength(2); // U+00E9
    expect(utf8('🔐')).toHaveLength(4); // one astral code point, a JS surrogate pair
  });

  it('preserves a distinction NFC would collapse — it normalizes nothing', () => {
    // canonicalizePassword owns normalization; if utf8 also folded, the two
    // spellings could not be told apart at the derivation boundary.
    expect(utf8('e\u0301')).not.toEqual(utf8('\u00e9'));
  });
});

// The base64 ⇄ bytes pair used for the inline preview-image wire form. Both halves
// live here now (the extractor encodes, the clients decode), so they round-trip
// against the same implementation.
describe('bytesToBase64 / base64ToBytes', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 128, 1]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('handles a body larger than the fromCharCode chunk size', () => {
    // 0x8000 is the chunk boundary in bytesToBase64; cross it to exercise chunking.
    const bytes = new Uint8Array(0x8000 + 100).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

// The URL/header-safe pair: bracemark-api's session tokens and the store JWTs.
describe('bytesToBase64Url / base64UrlToBytes', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 128, 1]);
    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
  });

  it('emits only URL-safe characters and no padding', () => {
    // 0xfb 0xff encodes to '+/' in standard base64, so this exercises both swaps;
    // a 2-byte input also forces a '=' pad that must be stripped.
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });

  it('round-trips every tail length (the padding cases)', () => {
    for (let len = 1; len <= 4; len++) {
      const bytes = new Uint8Array(len).map((_, i) => 0xf0 + i);
      expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
    }
  });

  it('decodes a JWS-style payload segment', () => {
    // What decoding an App Store JWS payload looks like end to end.
    const segment = bytesToBase64Url(utf8(JSON.stringify({ productId: 'plus.monthly' })));
    expect(segment).not.toMatch(/[+/=]/);
    expect(JSON.parse(bytesToUtf8(base64UrlToBytes(segment)))).toEqual({
      productId: 'plus.monthly',
    });
  });
});

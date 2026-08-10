import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  bytesToUtf8,
  utf8,
} from './encoding';

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

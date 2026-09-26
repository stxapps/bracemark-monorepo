import { decodeUtf8 } from './utf8';

// decodeUtf8 stands in for TextDecoder on the data path, so its contract is
// TextDecoder's output, byte for byte — Node's decoder is the reference. A
// mismatch would not throw anywhere: it would silently change a stored title.

const reference = new TextDecoder();
const encode = (text: string) => new TextEncoder().encode(text);
const bytes = (...values: number[]) => new Uint8Array(values);

it('decodes text in every UTF-8 width', () => {
  for (const text of [
    '',
    'plain ascii',
    'café',
    'ไทย',
    '日本語',
    '𝄞 emoji 🧭 pairs',
    '\u0000\u007f',
  ]) {
    expect(decodeUtf8(encode(text))).toBe(text);
  }
});

it('decodes a JSON blob the way the store writes it', () => {
  const blob = { url: 'https://example.com/ü', customTitle: 'Ünïcödé — 🧭', tagIds: ['a'] };
  expect(JSON.parse(decodeUtf8(encode(JSON.stringify(blob))))).toEqual(blob);
});

it('strips a leading BOM and keeps one anywhere else', () => {
  expect(decodeUtf8(bytes(0xef, 0xbb, 0xbf, 0x61))).toBe('a');
  expect(decodeUtf8(bytes(0x61, 0xef, 0xbb, 0xbf))).toBe('a﻿');
});

it('replaces malformed input exactly as TextDecoder does', () => {
  const cases = [
    bytes(0x80), // a lone continuation byte
    bytes(0xc0, 0x80), // an overlong NUL
    bytes(0xe0, 0x80, 0x80), // an overlong three-byte form
    bytes(0xed, 0xa0, 0x80), // an encoded surrogate
    bytes(0xf4, 0x90, 0x80, 0x80), // past U+10FFFF
    bytes(0xf5), // never a lead byte
    bytes(0xe2, 0x82), // truncated at the end
    bytes(0xe2, 0x82, 0x61), // truncated mid-string: the 'a' survives
    bytes(0xf0, 0x9f, 0x92), // a truncated four-byte form
    bytes(0xc2, 0xc2, 0xa9), // a lead byte cut short by another
  ];
  for (const input of cases) expect(decodeUtf8(input)).toBe(reference.decode(input));
});

it('carries a surrogate pair across the chunk boundary intact', () => {
  // 'x' shifts the pair's position through every alignment around 0x2000 units.
  for (let pad = 8185; pad < 8195; pad++) {
    const text = `${'x'.repeat(pad)}🧭${'ü'.repeat(5000)}`;
    expect(decodeUtf8(encode(text))).toBe(text);
  }
});

it('matches TextDecoder on random bytes', () => {
  // Seeded, so a failure reproduces.
  let seed = 0x2545f491;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let round = 0; round < 500; round++) {
    const input = new Uint8Array(next() % 64);
    // Weighted towards the bytes that start and continue sequences.
    for (let i = 0; i < input.length; i++) {
      const r = next() % 4;
      input[i] =
        r === 0 ? next() % 0x80 : r === 1 ? 0x80 + (next() % 0x40) : 0xc0 + (next() % 0x40);
    }
    expect(decodeUtf8(input)).toBe(reference.decode(input));
  }
});

import { describe, expect, it } from 'vitest';

import { readAllWithLimit, SafeFetchError } from './safe-fetch';

// The body-capping helper used by the inline-image path. The redirect / SSRF
// behavior of safeFetch is covered via the routes (extract/image .spec.ts) and
// ssrf.spec.ts; these are the pure size edges. (base64 encoding moved to
// @stxapps/shared — covered by crypto/encoding.spec.ts.)
describe('readAllWithLimit', () => {
  it('returns the full body when it is within the cap', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const out = await readAllWithLimit(new Response(bytes), 100);
    expect(out).toEqual(bytes);
  });

  it('throws too_large once the body exceeds the cap', async () => {
    const bytes = new Uint8Array(50);
    await expect(readAllWithLimit(new Response(bytes), 10)).rejects.toMatchObject({
      name: 'SafeFetchError',
      code: 'too_large',
    });
  });

  it('throws a SafeFetchError specifically', async () => {
    const bytes = new Uint8Array(50);
    await expect(readAllWithLimit(new Response(bytes), 10)).rejects.toBeInstanceOf(SafeFetchError);
  });
});

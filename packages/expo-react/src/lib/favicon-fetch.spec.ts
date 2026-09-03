// Specs for the favicon GUESS — the ONE standalone fetch this app makes to a host nothing
// on the device has contacted yet. That is what puts it behind the `deviceExtractionMode`
// opt-in, and it is why the two things asserted hardest here are the two that are visible
// from OUTSIDE the device:
//
//   - THE USER-AGENT. Honest and attributable, never a browser impersonation — a site that
//     wants to refuse this traffic should be able to, and a site that wants to ask about it
//     has somewhere to look. Nothing else checks that the header is actually sent; a
//     refactor that dropped it would leave every request anonymous with no visible symptom
//     on this side at all.
//   - THE URL. `https://{host}/favicon.ico`, https only. Anything else is a different
//     disclosure than the one the opt-in bought.
//
// And the one that is invisible from either side: validity is a BYTE SNIFF, not a
// content-type. A host that serves an HTML error page at the guessed path answers 200 with
// a perfectly good `text/html` — trusting the status (or the header) caches that as an
// icon, and the row then says `ok` with bytes the render path cannot decode. An SVG is NOT
// a miss: icons render through expo-image, which decodes it.
//
// The verdict itself is `@stxapps/shared`'s `isRenderableIconBytes`, shared with web's
// filler; it is exercised through the real function here rather than stubbed, so this also
// pins that this module asks the SHARED question and not a local approximation.

import { fetchFaviconBytes } from './favicon-fetch';
import { USER_AGENT } from './user-agent';

// The Response constructor's own body type, so the byte fixtures below don't have to name a
// lib-specific alias (RN's is `BodyInit_`, the DOM's is `BodyInit`).
type ResponseBody = ConstructorParameters<typeof Response>[0];

const HOST = 'github.com';

// Real bytes with real magic numbers, so `isRenderableIconBytes` decides for real.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0, 0, 0, 0]);
const HTML = new TextEncoder().encode('<!DOCTYPE html><html><body>404 not found</body></html>');

let fetchMock: jest.Mock;

function answers(body: Uint8Array, init: ResponseInit = {}): void {
  fetchMock.mockResolvedValue(
    new Response(body as unknown as ResponseBody, { status: 200, ...init }),
  );
}

beforeEach(() => {
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

const requested = (): [string, RequestInit] => fetchMock.mock.calls[0] as [string, RequestInit];

describe('fetchFaviconBytes', () => {
  it('guesses /favicon.ico over https on the host it was given', async () => {
    answers(PNG);

    await fetchFaviconBytes(HOST);

    expect(requested()[0]).toBe('https://github.com/favicon.ico');
  });

  // Attributable by design. The extractor states the same thing with a DIFFERENT string, so
  // a site that walls off the server isn't also walling off every phone — which only works
  // if this one is actually sent.
  it('identifies itself honestly rather than impersonating a browser', async () => {
    answers(PNG);

    await fetchFaviconBytes(HOST);

    const headers = new Headers(requested()[1].headers);
    expect(headers.get('User-Agent')).toBe(USER_AGENT);
    expect(USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari/);
  });

  it('returns the bytes when the host serves a renderable icon', async () => {
    answers(ICO);

    expect(await fetchFaviconBytes(HOST)).toEqual(ICO);
  });

  // THE SNIFF. This is the common real case — a host with no favicon.ico whose server
  // answers 200 with its HTML error page. Trusting the status caches an "icon" the render
  // path cannot decode, and the `ok` row then says the host is resolved forever.
  it('rejects a 200 whose body is not a decodable image', async () => {
    answers(HTML, { headers: { 'content-type': 'image/x-icon' } });

    expect(await fetchFaviconBytes(HOST)).toBeUndefined();
  });

  it('accepts an SVG, which the render path can decode', async () => {
    answers(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));

    expect(await fetchFaviconBytes(HOST)).toBeDefined();
  });

  it('returns nothing for a non-ok response', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));

    expect(await fetchFaviconBytes(HOST)).toBeUndefined();
  });

  // A transport failure propagates — the caller records `none` for it exactly as it does
  // for a miss, so the split is cosmetic. Pinned so that "throws" stays a deliberate part
  // of the contract rather than something the caller has to guess at.
  it('lets a transport failure propagate to the caller', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));

    await expect(fetchFaviconBytes(HOST)).rejects.toThrow('Network request failed');
  });

  // One site not answering must not pin a queue slot — this is decoration, so it runs on a
  // short leash. The signal has to actually be attached, or the timer aborts nothing.
  it('gives the request an abort signal so a hung host cannot hold a slot', async () => {
    answers(PNG);

    await fetchFaviconBytes(HOST);

    expect(requested()[1].signal).toBeInstanceOf(AbortSignal);
    expect(requested()[1].signal?.aborted).toBe(false);
  });

  // …and the timer is cleared on the way out, on BOTH paths. A leaked timer keeps the JS
  // context awake after the fetch settled — invisible in a test that only checks the
  // return value.
  it('clears its timeout whether the fetch succeeds or fails', async () => {
    const clear = jest.spyOn(globalThis, 'clearTimeout');

    answers(PNG);
    await fetchFaviconBytes(HOST);
    expect(clear).toHaveBeenCalledTimes(1);

    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    await fetchFaviconBytes(HOST).catch(() => undefined);
    expect(clear).toHaveBeenCalledTimes(2);

    clear.mockRestore();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRobotsReader, parseRobots, robotsVerdictFor } from './robots';

// robots.txt is honoured for read mode only, and published as such on /extractor — so
// what counts as "this service is disallowed" is pinned here, against RFC 9309.

const verdict = (text: string, url: string) => robotsVerdictFor(parseRobots(text), new URL(url));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseRobots + robotsVerdictFor', () => {
  it('obeys a group naming bracemark-extractor over the * group', () => {
    const text = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: bracemark-extractor',
      'Disallow: /private/',
    ].join('\n');
    expect(verdict(text, 'https://example.com/post')).toBe('allowed');
    expect(verdict(text, 'https://example.com/private/a')).toBe('disallowed');
  });

  it('falls back to the * group, and matches the product token case-insensitively', () => {
    expect(verdict('User-agent: *\nDisallow: /', 'https://example.com/a')).toBe('disallowed');
    expect(verdict('User-Agent: Bracemark-Extractor/1.0\nDisallow: /x', 'https://e.com/x')).toBe(
      'disallowed',
    );
    // A group for someone else doesn't bind this service.
    expect(verdict('User-agent: GPTBot\nDisallow: /', 'https://example.com/a')).toBe('allowed');
  });

  it('merges consecutive user-agent lines into one group', () => {
    const text = 'User-agent: other\nUser-agent: bracemark-extractor\nDisallow: /a';
    expect(verdict(text, 'https://example.com/a/b')).toBe('disallowed');
  });

  it('takes the longest match, and Allow on a tie', () => {
    const text = 'User-agent: *\nDisallow: /docs\nAllow: /docs/public\nAllow: /tie\nDisallow: /tie';
    expect(verdict(text, 'https://example.com/docs/secret')).toBe('disallowed');
    expect(verdict(text, 'https://example.com/docs/public/1')).toBe('allowed');
    expect(verdict(text, 'https://example.com/tie')).toBe('allowed');
  });

  it('understands * and an end-anchoring $', () => {
    const text = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /*/print';
    expect(verdict(text, 'https://example.com/a/b.pdf')).toBe('disallowed');
    expect(verdict(text, 'https://example.com/a/b.pdf?x=1')).toBe('allowed');
    expect(verdict(text, 'https://example.com/story/print?id=2')).toBe('disallowed');
    expect(verdict(text, 'https://example.com/story')).toBe('allowed');
  });

  it('matches the query string as part of the path', () => {
    expect(verdict('User-agent: *\nDisallow: /*?amp', 'https://e.com/a?amp=1')).toBe('disallowed');
  });

  it('treats an empty Disallow, comments and junk as no rule', () => {
    const text = '# hello\nUser-agent: * # everyone\nDisallow:\nCrawl-delay: 10\nnonsense';
    expect(verdict(text, 'https://example.com/anything')).toBe('allowed');
  });

  it('compares percent-encoding the RFC way', () => {
    expect(verdict('User-agent: *\nDisallow: /%7Ejoe', 'https://e.com/~joe/a')).toBe('disallowed');
    expect(verdict('User-agent: *\nDisallow: /café', 'https://e.com/caf%C3%A9')).toBe('disallowed');
  });

  it('never disallows /robots.txt, and survives a pathological pattern quickly', () => {
    expect(verdict('User-agent: *\nDisallow: /', 'https://e.com/robots.txt')).toBe('allowed');
    const stars = `/${'*a'.repeat(200)}b`;
    const started = Date.now();
    expect(verdict(`User-agent: *\nDisallow: ${stars}`, `https://e.com/${'a'.repeat(2000)}`)).toBe(
      'allowed',
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('createRobotsReader', () => {
  function stubRobots(response: () => Response) {
    const mock = vi.fn(() => Promise.resolve(response()));
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  it('reads an origin once per reader, and forgets it with the reader', async () => {
    const mock = stubRobots(
      () =>
        new Response('User-agent: *\nDisallow: /no', { headers: { 'content-type': 'text/plain' } }),
    );
    const read = createRobotsReader();
    expect(await read(new URL('https://example.com/no/1'))).toBe('disallowed');
    expect(await read(new URL('https://example.com/yes'))).toBe('allowed');
    expect(mock).toHaveBeenCalledTimes(1);
    expect(String((mock.mock.calls[0] as unknown[])[0])).toBe('https://example.com/robots.txt');

    await createRobotsReader()(new URL('https://example.com/yes'));
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('reads a 4xx as no rules, and a 5xx as unavailable', async () => {
    stubRobots(() => new Response('', { status: 404 }));
    expect(await createRobotsReader()(new URL('https://example.com/a'))).toBe('allowed');

    stubRobots(() => new Response('', { status: 503 }));
    expect(await createRobotsReader()(new URL('https://example.com/a'))).toBe('unavailable');
  });

  it('reads a network failure as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('down'))),
    );
    expect(await createRobotsReader()(new URL('https://example.com/a'))).toBe('unavailable');
  });
});

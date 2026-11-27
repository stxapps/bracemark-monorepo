import { selectFaviconUrl, selectTitleImage } from '@stxapps/shared';

import {
  collectHtmlMeta,
  decodeHtmlBytes,
  FIRST_READ_BYTES,
  MAX_HEAD_CHARS,
  parseHtmlHead,
} from './parse-html-head';

// The scanner's contract is "collect what the extractor's HTMLRewriter would collect",
// so these fixtures are the malformed-input hazards a regex scan can actually get
// wrong (parse-html-head.ts's header) — plus a couple of end-to-end cases run through
// the shared selectors, since the pair is what the worker uses.

const BASE = new URL('https://example.com/post/1');
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('parseHtmlHead', () => {
  it('collects the ordinary case', () => {
    const collected = parseHtmlHead(`
      <html><head>
        <title>Doc title</title>
        <meta property="og:title" content="OG title">
        <meta property="og:image" content="https://cdn.example.com/a.png">
        <link rel="icon" href="/favicon-32.png" sizes="32x32">
      </head><body>ignored</body></html>
    `);
    expect(collected).toMatchObject({
      docTitle: 'Doc title',
      ogTitle: 'OG title',
      ogImage: 'https://cdn.example.com/a.png',
      icons: [{ href: '/favicon-32.png', rel: 'icon', sizes: '32x32' }],
    });
  });

  it('reads twitter tags off `name` as well as `property`', () => {
    const collected = parseHtmlHead(`<meta name="twitter:image" content="/t.png">`);
    expect(collected.twitterImage).toBe('/t.png');
  });

  it('accepts single-quoted and unquoted attribute values', () => {
    const collected = parseHtmlHead(
      `<meta property='og:title' content='Single'><link rel=icon href=/i.png>`,
    );
    expect(collected.ogTitle).toBe('Single');
    expect(collected.icons).toEqual([
      { href: '/i.png', rel: 'icon', sizes: undefined, type: undefined },
    ]);
  });

  it('keeps the FIRST value per key, like the extractor', () => {
    const collected = parseHtmlHead(
      `<meta property="og:title" content="First"><meta property="og:title" content="Second">`,
    );
    expect(collected.ogTitle).toBe('First');
  });

  // Decoding is `@stxapps/shared`'s `decodeHtmlEntities` (its own spec covers the
  // table); what these pin is that the scanner routes BOTH the RCDATA title and the
  // attribute values through it, which is what the DOM would have done for the
  // extension and what the extractor now does for the server tier.
  it('decodes entities in titles and attributes', () => {
    const collected = parseHtmlHead(
      `<title>Tom &amp; Jerry &#8212; &quot;best&quot; &#x1F600;</title>`,
    );
    expect(collected.docTitle).toBe('Tom & Jerry — "best" 😀');
  });

  it('decodes the typographic entities a real blog title uses', () => {
    const collected = parseHtmlHead(
      `<title>Please stop calling databases CP or AP &mdash; Martin Kleppmann&rsquo;s blog</title>`,
    );
    expect(collected.docTitle).toBe(
      'Please stop calling databases CP or AP — Martin Kleppmann’s blog',
    );
  });

  it('decodes entities in an og:title and an og:image query string', () => {
    const collected = parseHtmlHead(`
      <meta property="og:title" content="Caf&eacute; &amp; co&hellip;">
      <meta property="og:image" content="https://cdn.example.com/a.png?w=1200&amp;h=630">
    `);
    expect(collected.ogTitle).toBe('Café & co…');
    expect(collected.ogImage).toBe('https://cdn.example.com/a.png?w=1200&h=630');
  });

  // The two hazards that make a naive scan collect things the page never declared.
  it('ignores tags inside comments', () => {
    const collected = parseHtmlHead(`
      <!-- <meta property="og:title" content="Commented out"> -->
      <title>Real</title>
    `);
    expect(collected.ogTitle).toBeUndefined();
    expect(collected.docTitle).toBe('Real');
  });

  it('ignores tag-like text inside inline scripts and styles', () => {
    const collected = parseHtmlHead(`
      <title>Real</title>
      <script>const s = '<meta property="og:image" content="/fake.png">';</script>
      <style>/* <link rel="icon" href="/fake.ico"> */</style>
    `);
    expect(collected.ogImage).toBeUndefined();
    expect(collected.icons).toBeUndefined();
  });

  it('stops at </head> once the head has declared its metadata', () => {
    const collected = parseHtmlHead(`
      <head><title>Real</title><meta property="og:title" content="Head"></head>
      <body><meta property="og:image" content="/from-body.png"></body>
    `);
    expect(collected).toEqual({ docTitle: 'Real', ogTitle: 'Head' });
  });

  // YouTube's channel pages, measured 2026-11-22: the head closes at 825 KB with only a
  // <title>, and og:title and og:image follow in the body — where the live DOM and the
  // extractor's HTMLRewriter both find them.
  it('reads the body when the head declared no og or twitter tag', () => {
    const collected = parseHtmlHead(`
      <head><title>Veritasium - YouTube</title><link rel="icon" href="/head.ico"></head>
      <body><script>${'x'.repeat(50_000)}</script>
        <meta property="og:title" content="Veritasium">
        <meta property="og:image" content="https://yt3.example/v.jpg">
        <link rel="icon" href="/body.ico"></body>
    `);
    expect(collected).toEqual({
      docTitle: 'Veritasium - YouTube',
      ogTitle: 'Veritasium',
      ogImage: 'https://yt3.example/v.jpg',
      icons: [{ href: '/head.ico', rel: 'icon', sizes: undefined, type: undefined }],
    });
  });

  // The icons are the head's even when the head declared none: a body `<link rel=icon>`
  // is where a visitor's markup sits, not where a site declares its favicon.
  it('never takes a body icon for the favicon, even when the head has none', () => {
    const collected = parseHtmlHead(`
      <head><title>T</title></head>
      <body><meta property="og:title" content="Body"><link rel="icon" href="https://evil.example/i.png"></body>
    `);
    expect(collected).toEqual({ docTitle: 'T', ogTitle: 'Body' });
  });

  // YouTube's watch pages: og:title ~850 KB in, inside a head the size of its inline
  // data — past the old 256 KB cap, under MAX_HEAD_CHARS.
  it('reaches og tags ~850 KB into a long head', () => {
    const collected = parseHtmlHead(
      `<head><title>A video - YouTube</title>${'<link rel="preload" href="/x">'.repeat(28_000)}` +
        `<meta property="og:title" content="A video"></head>`,
    );
    expect(collected.ogTitle).toBe('A video');
  });

  // The head's end is the first `</head>` OUTSIDE a script or comment.
  it('does not take a `</head>` inside a script or comment for the head’s end', () => {
    const collected = parseHtmlHead(`
      <head><script>document.write("</head>")</script><!-- </head> -->
      <meta property="og:title" content="Still head"></head>
      <body><meta property="og:image" content="/body.png"></body>
    `);
    expect(collected).toEqual({ ogTitle: 'Still head' });
  });

  // A `<!--` inside a script is script, as HTML reads it: the comment it seems to open
  // must not swallow the metadata after the script.
  it('skips whichever span opens first', () => {
    const collected = parseHtmlHead(`
      <script>if (a <!--b) {}</script>
      <meta property="og:title" content="After the script">
      <!-- a real comment -->
    `);
    expect(collected.ogTitle).toBe('After the script');
  });

  // A page that never closes <head> is common enough (and a scanner has no tree to
  // fall back on), so the whole capped input is scanned rather than nothing.
  it('scans everything when there is no </head>', () => {
    const collected = parseHtmlHead(`<title>Real</title><meta property="og:title" content="OG">`);
    expect(collected.ogTitle).toBe('OG');
  });

  it('survives a page with no head metadata at all', () => {
    expect(parseHtmlHead('<html><body><p>hi</p></body></html>')).toEqual({});
  });

  // A boolean attribute has no `=`; the tokenizer consumes it as a bare name, and the
  // attributes after it must still be read.
  it('reads attributes that follow a valueless one', () => {
    const collected = parseHtmlHead(`<link rel="icon" crossorigin href="/i.png">`);
    expect(collected.icons?.map((i) => i.href)).toEqual(['/i.png']);
  });

  // HTML's rule: an unclosed comment or script swallows the rest of the page, and
  // what follows it is its text, not tags (scan-meta.ts, scanTags). The rule before it
  // read on past them, which read a cut script's strings as tags.
  it.each([
    ['comment', '<!-- never closed'],
    ['script', '<script> never closed'],
    ['textarea', '<textarea> never closed'],
  ])('reads nothing after an unclosed %s, as the DOM does', (_name, opener) => {
    const collected = parseHtmlHead(`
      <meta property="og:image" content="/before.jpg">
      ${opener}
      <meta property="og:title" content="After">
    `);
    expect(collected).toEqual({ ogImage: '/before.jpg' });
  });

  it('never reads tags out of a script the cap cut off', () => {
    const script = `<script>var data = '<meta property="og:image" content="https://evil.example/x.png">';`;
    const collected = parseHtmlHead(
      `<html><head><title>T</title>${script}${'x'.repeat(MAX_HEAD_CHARS)}</script></head></html>`,
    );
    expect(collected).toEqual({ docTitle: 'T' });
  });

  it('collects every icon rel in document order for the selector to rank', () => {
    const collected = parseHtmlHead(`
      <link rel="shortcut icon" href="/legacy.ico">
      <link rel="apple-touch-icon" href="/at.png" sizes="180x180">
      <link rel="mask-icon" href="/pin.svg">
      <link rel="stylesheet" href="/app.css">
    `);
    expect(collected.icons?.map((i) => i.href)).toEqual(['/legacy.ico', '/at.png', '/pin.svg']);
  });
});

// A page can be built to stall a regex scanner: thousands of openers with no closer
// make a `[^>]*>` or `.*?-->` retry from each one to the end, quadratic on EVERY
// engine (@stxapps/shared html/scan-meta.ts, _why the scan below is hand-rolled_). The drain fetches
// pages nobody gestured for, on the JS thread, so each case is sized near
// MAX_HEAD_CHARS and must finish inside a budget. The margin is deliberately wide:
// these take a few ms linear, and the regexes they replaced took 1–13 s each on V8,
// so 250 ms neither flakes on a loaded machine nor passes a revert. Each also asserts
// the real tag in front of the junk is still collected, which is the positive control.
//
// EACH CASE RUNS AT 64 KB FIRST, against 50 ms. A synchronous call can't be interrupted
// by jest's timeout, so a quadratic revert at the full cap holds the suite for minutes
// (one did, for 188 s) before it fails; at 64 KB linear is well under a millisecond and
// quadratic fails in about a second, and the full-cap run never starts.
describe('parseHtmlHead on hostile input', () => {
  const BUDGET_MS = 250;
  const FAIL_FAST_MS = 50;
  const REAL = '<meta property="og:title" content="Real">';

  const timed = (html: string): { ogTitle?: string; ms: number } => {
    const start = performance.now();
    const { ogTitle } = parseHtmlHead(html);
    return { ogTitle, ms: performance.now() - start };
  };
  // `page(chars)` is the hostile page at about that many characters.
  const expectLinear = (page: (chars: number) => string): void => {
    const small = timed(page(64 * 1024));
    expect(small.ms).toBeLessThan(FAIL_FAST_MS);
    const full = timed(page(MAX_HEAD_CHARS - 1024));
    expect(full.ogTitle).toBe('Real');
    expect(full.ms).toBeLessThan(BUDGET_MS);
  };
  const repeated =
    (unit: string, before = '') =>
    (chars: number) =>
      before + REAL + unit.repeat(Math.floor(chars / unit.length));

  it.each([
    ['comment', '<!--x'],
    ['script', '<script>x'],
    ['style', '<style>x'],
    ['title', '<title>x'],
    ['CDATA', '<![CDATA[x'],
    ['title with no `>`', '<title '],
    ['meta with no `>`', '<meta '],
    ['link with no `>`', '<link '],
  ])('stays linear on thousands of unclosed %s openers', (_name, opener) => {
    expectLinear(repeated(opener));
  });

  // The walk keeps each kind's next opener until it passes it; one that re-searched every
  // kind at every span would be quadratic here.
  it('stays linear on thousands of closed spans of every kind, interleaved', () => {
    expectLinear(repeated('<!----><!---><!--><script></script><style></style><![CDATA[]]>'));
  });

  // An empty head sends the scan through the whole page: the body read must be as
  // linear as the head's.
  it.each([
    ['meta with no `>`', '<meta '],
    ['comment', '<!--x'],
    ['script', '<script>x'],
    ['`="` with no closing quote', '<meta a="'],
    ['`=` with no value', '<meta a= '],
    ['empty tags', '<b>'],
  ])('stays linear reading a hostile body of %s after an empty head', (_name, unit) => {
    expectLinear(repeated(unit, '<head></head>'));
  });

  // The quote-aware tag end (scan-meta.ts, tagEnd): each quote's closer is searched once
  // and jumped past, so neither quoted `>`s nor a chain of `="` with no `>` re-scans.
  it.each([
    ['quoted values holding `>`', '<meta a="x>y" b=\'>\'>'],
    ['`="` with no closing `>`', '<meta a="'],
  ])('stays linear on thousands of tags with %s', (_name, unit) => {
    expectLinear(repeated(unit));
  });

  it('stays linear on one enormous attribute name with no `=`', () => {
    expectLinear((chars) => `<meta ${'a'.repeat(chars)} property="og:title" content="Real">`);
  });
});

// The two-step read (parse-html-head.ts, collectHtmlMeta): FIRST_READ_BYTES first, and
// the cap only when that read's answer isn't settled. Each case is a page where
// stopping at the first read would give a different answer from the whole cap.
describe('collectHtmlMeta', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const pad = (n: number) => `<!-- ${'x'.repeat(n)} -->`;

  it('answers from the first read when its head closed there, declaring a field', () => {
    const page = `<head><meta property="og:title" content="A"></head><body>${'x'.repeat(2 * FIRST_READ_BYTES)}</body>`;
    expect(collectHtmlMeta(bytes(page))).toEqual({ ogTitle: 'A' });
  });

  it('reads on when the head runs past the first read', () => {
    const page = `<head><meta property="og:title" content="A">${pad(FIRST_READ_BYTES)}<link rel="icon" href="/late.png"></head>`;
    expect(collectHtmlMeta(bytes(page))).toEqual({
      ogTitle: 'A',
      icons: [{ href: '/late.png', rel: 'icon', sizes: undefined, type: undefined }],
    });
  });

  // A script cut by the first read is not markup there either: the walk stops at it,
  // the head hasn't closed, and the whole cap is read.
  it('never answers from a first read that cut a script holding tags', () => {
    const page = `<head><meta property="og:title" content="A"><script>${'x'.repeat(FIRST_READ_BYTES)}'<meta property="og:image" content="https://evil.example/x.png"></head>'</script><link rel="icon" href="/i.png"></head>`;
    expect(collectHtmlMeta(bytes(page))).toEqual({
      ogTitle: 'A',
      icons: [{ href: '/i.png', rel: 'icon', sizes: undefined, type: undefined }],
    });
  });

  // A quoted value cut by the first read is a value there too: the `</head>` inside it is
  // text, the walk stops at the quote, and the whole cap is read.
  it('never answers from a first read that cut a quoted value', () => {
    const page = `<head><meta property="og:title" content="A"><meta name="x" content='></head>${'y'.repeat(FIRST_READ_BYTES)}'><link rel="icon" href="/i.png"></head>`;
    expect(collectHtmlMeta(bytes(page))).toEqual({
      ogTitle: 'A',
      icons: [{ href: '/i.png', rel: 'icon', sizes: undefined, type: undefined }],
    });
  });

  // A head that closed early with no og tag says nothing about the body: YouTube's
  // channel pages, past the first read.
  it('reads on when the first read closed a head that declared nothing', () => {
    const page = `<head><title>T</title></head><body>${'x'.repeat(2 * FIRST_READ_BYTES)}<meta property="og:title" content="Body"></body>`;
    expect(collectHtmlMeta(bytes(page))).toEqual({ docTitle: 'T', ogTitle: 'Body' });
  });

  it('reads no more than the cap', () => {
    const page = `<head></head><body>${'x'.repeat(MAX_HEAD_CHARS)}<meta property="og:title" content="Late"></body>`;
    expect(collectHtmlMeta(bytes(page))).toEqual({});
  });

  // The cap is on BYTES decoded (each costs JS decode time on Hermes), not characters:
  // 600 K two-byte characters are 1.2 MB, past it.
  it('decodes no more than the cap, in bytes', () => {
    const page = `<head></head><body>${'é'.repeat(600_000)}<meta property="og:title" content="Late"></body>`;
    expect(collectHtmlMeta(bytes(page))).toEqual({});
  });
});

describe('decodeHtmlBytes', () => {
  it('decodes utf-8 by default', () => {
    expect(decodeHtmlBytes(utf8('<title>café — 😀</title>'))).toContain('café — 😀');
  });

  it('decodes a windows-1252 page declared in the content-type header', () => {
    // 0x92 is a right single quote in cp1252 — the character that makes the fallback
    // worth having (latin-1 would render it as a control char).
    const bytes = new Uint8Array([...utf8('<title>It'), 0x92, ...utf8('s</title>')]);
    expect(decodeHtmlBytes(bytes, 'text/html; charset=windows-1252')).toBe('<title>It’s</title>');
  });

  it('decodes a windows-1252 page declared only by a meta tag', () => {
    const bytes = new Uint8Array([
      ...utf8('<meta charset="iso-8859-1"><title>It'),
      0x92,
      ...utf8('s</title>'),
    ]);
    expect(decodeHtmlBytes(bytes)).toContain('It’s');
  });

  it('prefers the header charset over the document', () => {
    const bytes = utf8('<meta charset="windows-1252"><title>café</title>');
    expect(decodeHtmlBytes(bytes, 'text/html; charset=utf-8')).toContain('café');
  });
});

describe('parse + select together', () => {
  it('yields the title and an absolute image url', () => {
    const collected = parseHtmlHead(`
      <title>Doc</title>
      <meta property="og:title" content="  OG   title ">
      <meta property="og:image" content="/img/hero.png">
    `);
    expect(selectTitleImage(collected, BASE)).toEqual({
      title: 'OG title',
      imageUrl: 'https://example.com/img/hero.png',
    });
  });

  it('yields the declared favicon over the /favicon.ico guess', () => {
    const collected = parseHtmlHead(`<link rel="icon" href="/assets/i.png" sizes="48x48">`);
    expect(selectFaviconUrl(collected, BASE)).toBe('https://example.com/assets/i.png');
  });

  it('leaves both undefined for a page with nothing to offer', () => {
    const collected = parseHtmlHead('<html><body>hi</body></html>');
    expect(selectTitleImage(collected, BASE)).toEqual({ title: undefined, imageUrl: undefined });
    expect(selectFaviconUrl(collected, BASE)).toBeUndefined();
  });
});

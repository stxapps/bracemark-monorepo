import { selectFaviconUrl, selectTitleImage } from '@stxapps/shared';

import { decodeHtmlBytes, MAX_HEAD_CHARS, parseHtmlHead } from './parse-html-head';

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

  // The scanner's choice, not HTML's: an unclosed comment or script is left in place
  // rather than swallowing the rest of the page, so the metadata after it survives.
  it('keeps the metadata after an unclosed comment or script', () => {
    const collected = parseHtmlHead(`
      <!-- never closed
      <script> never closed
      <meta property="og:title" content="After">
    `);
    expect(collected.ogTitle).toBe('After');
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
describe('parseHtmlHead on hostile input', () => {
  const BUDGET_MS = 250;
  const REAL = '<meta property="og:title" content="Real">';

  const timed = (html: string): { ogTitle?: string; ms: number } => {
    const start = performance.now();
    const { ogTitle } = parseHtmlHead(html);
    return { ogTitle, ms: performance.now() - start };
  };

  it.each([
    ['comment', '<!--x'],
    ['script', '<script>x'],
    ['style', '<style>x'],
    ['title', '<title>x'],
    ['title with no `>`', '<title '],
    ['meta with no `>`', '<meta '],
    ['link with no `>`', '<link '],
  ])('stays linear on thousands of unclosed %s openers', (_name, opener) => {
    const { ogTitle, ms } = timed(
      REAL + opener.repeat(Math.floor((MAX_HEAD_CHARS - 1024) / opener.length)),
    );
    expect(ogTitle).toBe('Real');
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  // The walk keeps each kind's next opener until it passes it; one that re-searched every
  // kind at every span would be quadratic here.
  it('stays linear on thousands of closed spans of every kind, interleaved', () => {
    const unit = '<!----><script></script><style></style>';
    const { ogTitle, ms } = timed(
      REAL + unit.repeat(Math.floor((MAX_HEAD_CHARS - 1024) / unit.length)),
    );
    expect(ogTitle).toBe('Real');
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  // An empty head sends the scan through the whole page: the second read must be as
  // linear as the first.
  it('stays linear reading a hostile body after an empty head', () => {
    const { ogTitle, ms } = timed(
      '<head></head>' + REAL + '<meta '.repeat(Math.floor((MAX_HEAD_CHARS - 1024) / 6)),
    );
    expect(ogTitle).toBe('Real');
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('stays linear on one enormous attribute name with no `=`', () => {
    const { ogTitle, ms } = timed(
      `<meta ${'a'.repeat(30_000)} property="og:title" content="Real">`,
    );
    expect(ogTitle).toBe('Real');
    expect(ms).toBeLessThan(BUDGET_MS);
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

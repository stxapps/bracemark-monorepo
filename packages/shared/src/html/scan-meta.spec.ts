import { scanHtmlBodyMeta, scanHtmlMeta, scanHtmlMetaReport } from './scan-meta';

// The markup collector's two reaches. Its hostile-input budgets and its fixtures for
// real heads live with its first caller (expo-react lib/parse-html-head.spec.ts, which
// runs it `through: 'head'`); what this file pins is the difference `through` makes.

const BIG = 1024 * 1024;

// m.youtube.com's shape (measured 2026-11-22): a short head, then hundreds of KB of
// inline script, then the og tags in the BODY.
const MOBILE_YOUTUBE = `<!doctype html><html><head>
  <title>The new video - YouTube</title>
  <script>var ytInitialData = {"x":"<meta property=\\"og:title\\" content=\\"in a string\\">"};</script>
</head><body>
  <svg><title>an icon</title></svg>
  <script>${'x'.repeat(200_000)}</script>
  <meta property="og:title" content="The new video &amp; more">
  <meta property="og:image" content="https://i.ytimg.com/vi/new/hqdefault.jpg">
  <link rel="image_src" href="https://i.ytimg.com/vi/new/0.jpg">
</body></html>`;

describe('scanHtmlMeta', () => {
  it("stops at </head> when asked to — a body's tags are not read", () => {
    expect(scanHtmlMeta(MOBILE_YOUTUBE, { maxChars: BIG, through: 'head' })).toEqual({
      docTitle: 'The new video - YouTube',
    });
  });

  it("reads the body's tags through the document, decoded, never a script's text", () => {
    expect(scanHtmlMeta(MOBILE_YOUTUBE, { maxChars: BIG, through: 'document' })).toEqual({
      docTitle: 'The new video - YouTube',
      ogTitle: 'The new video & more',
      ogImage: 'https://i.ytimg.com/vi/new/hqdefault.jpg',
      imageSrc: 'https://i.ytimg.com/vi/new/0.jpg',
    });
  });

  it("never takes an SVG's <title> in the body for the page's, once the head closed", () => {
    const html = '<html><head></head><body><svg><title>an icon</title></svg></body></html>';
    expect(scanHtmlMeta(html, { maxChars: BIG, through: 'document' })).toEqual({});
  });

  // A `>` ends a tag only outside a quoted value (scan-meta.ts, tagEnd), as the live DOM
  // and HTMLRewriter read it. Breadcrumb titles carry one. The bare value before it is
  // crossed without ending the tag.
  it('keeps a tag whole when a quoted value holds a `>`', () => {
    const html = `<head>
      <meta name=og property=og:title content="Home > Shop > Lamp">
      <meta content='https://e.com/a.jpg?x=1>2' name='twitter:image'>
      <link rel="icon" href="/i.png" title="a > b">
    </head>`;
    expect(scanHtmlMeta(html, { maxChars: BIG, through: 'head' })).toEqual({
      ogTitle: 'Home > Shop > Lamp',
      twitterImage: 'https://e.com/a.jpg?x=1>2',
      icons: [{ href: '/i.png', rel: 'icon', sizes: undefined, type: undefined }],
    });
  });

  it('opens a value only after `=`: a stray quote is a character', () => {
    const html = `<head><meta " property="og:title" content="Real"><meta property="og:image" content="/i.jpg"></head>`;
    expect(scanHtmlMeta(html, { maxChars: BIG, through: 'head' })).toEqual({
      ogTitle: 'Real',
      ogImage: '/i.jpg',
    });
  });

  // An unclosed quote swallows the rest of the input, as in a browser: what follows is
  // the value's text, not tags.
  it('reads nothing after a quote that never closes, as the DOM does', () => {
    const html = `<head><meta property="og:image" content="/i.jpg"><meta name=twitter:image content='/broken.jpg><meta property=og:title content=After></head>`;
    expect(scanHtmlMeta(html, { maxChars: BIG, through: 'head' })).toEqual({ ogImage: '/i.jpg' });
  });

  // A page's SSR props in one long double-quoted attribute, `"` escaped and `<>` not, cut
  // by the cap: past the cut the value goes on, so a visitor's text inside it is still
  // text. (The rule before 2026-11-27 ended the tag at the next `>` and read on.)
  it('never reads tags out of an attribute value the cap cut off', () => {
    const visitor = '<meta property=og:image content=https://evil.example/p.png>';
    const html = `<html><head><title>t</title></head><body><div data-props="{&quot;comment&quot;:&quot;${visitor}${visitor}&quot;}"></div><meta property=og:title content=After></body>`;
    // Cut after the visitor's text, before the value's closing quote. Twice, because the
    // old rule ended the `<div>` at the first one's `>` and read the second as a tag.
    const cut = html.indexOf(visitor) + 2 * visitor.length + 4;
    expect(scanHtmlMeta(html, { maxChars: cut, through: 'document' })).toEqual({ docTitle: 't' });
    // Control: read whole, the value closes and the walk reads on.
    expect(scanHtmlMeta(html, { maxChars: BIG, through: 'document' })).toEqual({
      docTitle: 't',
      ogTitle: 'After',
    });
  });

  // Text the DOM reads as text, or keeps out of the document, is never a tag here: a
  // visitor who can post raw markup into one of these must not choose the preview of a
  // page whose head declares none (scan-meta.ts, RAW_TEXT and scanTags).
  const FORGED = '<meta property="og:image" content="https://tracker.example/p.png">';
  it.each([
    ['a textarea', `<textarea>${FORGED}</textarea>`],
    ['a template', `<template>${FORGED}</template>`],
    ['a noscript', `<noscript>${FORGED}</noscript>`],
    ['an xmp', `<xmp>${FORGED}</xmp>`],
    ['an iframe', `<iframe>${FORGED}</iframe>`],
    ['a noembed', `<noembed>${FORGED}</noembed>`],
    ['a noframes', `<noframes>${FORGED}</noframes>`],
    ['a body title', `<svg><title>${FORGED}</title></svg>`],
    ['a closer in another case', `<TextArea>${FORGED}</TEXTAREA >`],
    ['a near-miss closer', `<textarea></textareas>${FORGED}</textarea>`],
    ['a CDATA section', `<svg><![CDATA[ a > ${FORGED} ]]></svg>`],
    ['a bogus comment', `<?x ${FORGED.replace('>', '')} ?>`],
    ['a bogus comment after a text `<`', `a < b <?x ${FORGED}`],
    ['an end-tag bogus comment', `</ ${FORGED}`],
    ['a doctype-like bogus comment', `<!x ${FORGED.replace('>', '')}>`],
    ['an end tag', `</p title='${FORGED}'>`],
    ['a double-quoted attribute value', `<img alt="${FORGED.replaceAll('"', "'")}">`],
    ['a single-quoted attribute value', `<div title='${FORGED}'></div>`],
    ['an unclosed comment', `<!-- ${FORGED}`],
    ['an unclosed CDATA section', `<svg><![CDATA[ x > ${FORGED}`],
    ['a value after a no-break space', `<img alt=\u00a0"x><textarea>"> ${FORGED}</textarea>`],
    [
      'a link spelled with a KELVIN SIGN',
      '<lin\u212a rel=image_src href=https://evil.example/k.png>',
    ],
    ['a script closer followed by a no-break space', `<script></script\u00a0>${FORGED}</script>`],
    ['a plaintext', `<plaintext>${FORGED}`],
  ])('collects no tag out of %s', (_name, body) => {
    const html = `<html><head><title>t</title></head><body><p>A visitor wrote:</p>${body}<p>end</p></body></html>`;
    expect(scanHtmlMeta(html, { maxChars: BIG, through: 'document' })).toEqual({ docTitle: 't' });
  });

  it('still reads the tags around those spans', () => {
    const html = `<head></head><body><textarea>${FORGED}</textarea><meta property="og:title" content="Real"><template></template><SCRIPT>x</Script\t><META PROPERTY="og:image" CONTENT="/i.jpg"></body>`;
    expect(scanHtmlMeta(html, { maxChars: BIG, through: 'document' })).toEqual({
      ogTitle: 'Real',
      ogImage: '/i.jpg',
    });
  });

  // The tokenizer's empty comments: each ends where it opens, and the tag after it is
  // the page's.
  it.each([['<!-->'], ['<!--->'], ['<!---->'], ['<!-- a -- b --!>']])(
    'reads on after the comment %s',
    (comment) => {
      const html = `<head>${comment}<meta property="og:title" content="After"></head>`;
      expect(scanHtmlMeta(html, { maxChars: BIG, through: 'head' })).toEqual({ ogTitle: 'After' });
    },
  );

  // getAttribute's rules: the first of a repeated attribute, and '' for a bare name.
  it('takes the first of a repeated attribute, as the DOM does', () => {
    const html = `<head><meta property="og:title" content="First" content="Second"><meta property="og:image" content content="/x.jpg"></head>`;
    expect(scanHtmlMeta(html, { maxChars: BIG, through: 'head' })).toEqual({ ogTitle: 'First' });
  });

  it('closes the head at `</head>` only, not at any four-letter end tag', () => {
    const html = `<head></span></body><meta property="og:title" content="A"></head>`;
    expect(scanHtmlMeta(html, { maxChars: BIG, through: 'head' })).toEqual({ ogTitle: 'A' });
  });

  it('does not take a custom element for a meta', () => {
    const html = `<head><meta-tag property="og:title" content="No"></meta-tag></head>`;
    expect(scanHtmlMeta(html, { maxChars: BIG, through: 'head' })).toEqual({});
  });

  // `headEnd` is the settled rule: the head closed inside the read, so no longer read
  // could change the answer. A span the read cut ends the walk before any `</head>`.
  it('reports where the head ended only when it closed inside the read', () => {
    const closed = '<head><meta property="og:title" content="A"></head><body>';
    expect(scanHtmlMetaReport(closed, { maxChars: BIG, through: 'head' }).headEnd).toBe(
      closed.indexOf('<body>'),
    );
    const cutAt = (opener: string, closer: string) => {
      const page = `<head><meta property="og:title" content="A">${opener}${'x'.repeat(100)}</head>${closer}</head>`;
      return scanHtmlMetaReport(page, { maxChars: 120, through: 'head' }).headEnd;
    };
    expect(cutAt('<script>', '</script>')).toBeUndefined();
    expect(cutAt("<meta content='", "'>")).toBeUndefined();
    expect(cutAt('<![CDATA[', ']]>')).toBeUndefined();
    expect(cutAt('<!--', '-->')).toBeUndefined();
  });

  // The body read resumes the head read: together they are the whole-document scan.
  it('reads the body from where the head read stopped, as one document scan would', () => {
    const page = `<head><title>T</title><link rel=icon href=/h.ico></head><body><title>no</title><meta property=og:title content=B><link rel=icon href=/b.ico><textarea><meta property=og:image content=/x></textarea></body>`;
    const { headEnd } = scanHtmlMetaReport(page, { maxChars: BIG, through: 'head' });
    expect(headEnd).toBeDefined();
    const body = scanHtmlBodyMeta(page, { maxChars: BIG, headEnd: headEnd ?? 0 });
    expect(body).toEqual({
      ogTitle: 'B',
      icons: [{ href: '/b.ico', rel: 'icon', sizes: undefined, type: undefined }],
    });
    const whole = scanHtmlMeta(page, { maxChars: BIG, through: 'document' });
    const head = scanHtmlMeta(page, { maxChars: BIG, through: 'head' });
    expect({ ...body, ...head, icons: [...(head.icons ?? []), ...(body.icons ?? [])] }).toEqual(
      whole,
    );
  });

  it('reads no further than maxChars', () => {
    expect(scanHtmlMeta(MOBILE_YOUTUBE, { maxChars: 100_000, through: 'document' })).toEqual({
      docTitle: 'The new video - YouTube',
    });
  });
});

// The walk's linear-time pins, at 64 KB against 50 ms: linear takes well under a
// millisecond, and a walk that turned quadratic (one that read on past an unclosed span
// from the next character, say) a hundred times that. Small on purpose — a synchronous
// call can't be interrupted by jest's timeout, so a full-size case would hold the suite
// for minutes instead of failing. expo-react parse-html-head.spec.ts runs the same
// shapes at the full cap, each after its own 64 KB check.
describe('scanHtmlMeta on hostile input', () => {
  const REAL = '<meta property="og:title" content="Real">';
  it.each([
    ['comment', '<!--x'],
    ['script', '<script>x'],
    ['CDATA', '<![CDATA[x'],
    ['meta with no `>`', '<meta '],
    ['end tag with no `>`', '</a '],
    ['bogus comment with no `>`', '<!x'],
    ['`="` with no closing quote', '<meta a="'],
    ['`=` with no value', '<meta a= '],
    ['empty tags', '<b>'],
    ['empty comments', '<!--->'],
  ])('fails fast if the walk turns quadratic on %s', (_name, unit) => {
    const html = '<head></head>' + REAL + unit.repeat(Math.floor((64 * 1024) / unit.length));
    const start = performance.now();
    const collected = scanHtmlMeta(html, { maxChars: BIG, through: 'document' });
    expect(performance.now() - start).toBeLessThan(50);
    expect(collected.ogTitle).toBe('Real');
  });
});

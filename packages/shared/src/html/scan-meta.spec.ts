import { scanHtmlMeta } from './scan-meta';

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

  it("never takes an SVG's <title> in the body for the page's", () => {
    const html = '<html><head></head><body><svg><title>an icon</title></svg></body></html>';
    expect(scanHtmlMeta(html, { maxChars: BIG, through: 'document' })).toEqual({});
  });

  // A `>` ends a tag only outside a quoted value (scan-meta.ts, tagEnd), as the live DOM
  // and HTMLRewriter read it. Breadcrumb titles carry one.
  it('keeps a tag whole when a quoted value holds a `>`', () => {
    const html = `<head>
      <meta property="og:title" content="Home > Shop > Lamp">
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

  // An unclosed quote is the last of its kind in the input. A browser would let it swallow
  // the rest; the scanner ends that tag at its next `>` and reads on.
  it('lets a quote that never closes cost its own tag only', () => {
    const html = `<head><meta property="og:image" content="/i.jpg"><meta name=twitter:image content='/broken.jpg><meta property=og:title content=After></head>`;
    expect(scanHtmlMeta(html, { maxChars: BIG, through: 'head' })).toEqual({
      ogImage: '/i.jpg',
      ogTitle: 'After',
    });
  });

  it('reads no further than maxChars', () => {
    expect(scanHtmlMeta(MOBILE_YOUTUBE, { maxChars: 100_000, through: 'document' })).toEqual({
      docTitle: 'The new video - YouTube',
    });
  });
});

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

  it('reads no further than maxChars', () => {
    expect(scanHtmlMeta(MOBILE_YOUTUBE, { maxChars: 100_000, through: 'document' })).toEqual({
      docTitle: 'The new video - YouTube',
    });
  });
});

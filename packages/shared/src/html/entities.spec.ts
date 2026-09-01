import { CP1252_HIGH, decodeHtmlEntities } from './entities';

// The step the DOM does for free and the two raw-HTML parsers have to do themselves
// (entities.ts's header). The bug that earned this file: a `<title>` is RCDATA, so
// `HTMLRewriter`'s text chunks — and its `getAttribute` — hand back the source
// spelling, and a personal blog with no og:title stored `Kleppmann&rsquo;s blog`.

describe('decodeHtmlEntities', () => {
  it('decodes the reported title verbatim', () => {
    expect(
      decodeHtmlEntities(
        'Please stop calling databases CP or AP &mdash; Martin Kleppmann&rsquo;s blog',
      ),
    ).toBe('Please stop calling databases CP or AP — Martin Kleppmann’s blog');
  });

  it.each([
    ['&amp;', '&'],
    ['&lt;', '<'],
    ['&gt;', '>'],
    ['&quot;', '"'],
    ['&apos;', "'"],
    ['&nbsp;', ' '],
    ['&mdash;', '—'],
    ['&ndash;', '–'],
    ['&rsquo;', '’'],
    ['&lsquo;', '‘'],
    ['&ldquo;', '“'],
    ['&rdquo;', '”'],
    ['&hellip;', '…'],
    ['&eacute;', 'é'],
    ['&trade;', '™'],
    ['&euro;', '€'],
    ['&rarr;', '→'],
    ['&lambda;', 'λ'],
  ])('decodes %s', (entity, char) => {
    expect(decodeHtmlEntities(entity)).toBe(char);
  });

  it('decodes decimal and hex numeric references', () => {
    expect(decodeHtmlEntities('&#8212;&#x2014;&#38;&#X26;')).toBe('——&&');
  });

  it('decodes astral numeric references (an emoji in a title)', () => {
    expect(decodeHtmlEntities('&#128512;')).toBe('😀');
  });

  it('remaps the windows-1252 numeric range the way a browser does', () => {
    // A CMS that wrote &#146; meant `’`, not U+0092 (an unprintable control).
    expect(decodeHtmlEntities('Kleppmann&#146;s blog &#151; a post')).toBe(
      'Kleppmann’s blog — a post',
    );
  });

  it('is case-sensitive, because the table holds both spellings', () => {
    expect(decodeHtmlEntities('&Alpha;&alpha;&Prime;&prime;')).toBe('Αα″′');
  });

  it('leaves an unknown name literal rather than dropping it', () => {
    expect(decodeHtmlEntities('a &DoubleLongLeftRightArrow; b')).toBe(
      'a &DoubleLongLeftRightArrow; b',
    );
  });

  it.each([
    ['a bare ampersand between words', 'Ben & Jerry’s'],
    ['a name with no semicolon', 'AT&T and R&D'],
    ['an ampersand-equals in a url', 'https://x.test/?a=1&b=2'],
  ])('leaves %s alone', (_name, text) => {
    expect(decodeHtmlEntities(text)).toBe(text);
  });

  it('decodes in ONE pass, so a doubly-escaped reference stays literal', () => {
    // The page said `&lt;`; it did not say `<`.
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
  });

  it('leaves an out-of-range or surrogate numeric reference literal', () => {
    expect(decodeHtmlEntities('&#0;&#xD800;&#1114112;')).toBe('&#0;&#xD800;&#1114112;');
  });

  it('returns text with no ampersand unchanged', () => {
    expect(decodeHtmlEntities('nothing to do here')).toBe('nothing to do here');
  });
});

describe('CP1252_HIGH', () => {
  it('covers 0x80–0x9F with the five unassigned slots blank', () => {
    expect(CP1252_HIGH).toHaveLength(32);
    expect(CP1252_HIGH[0x91 - 0x80]).toBe('‘');
    expect(CP1252_HIGH[0x97 - 0x80]).toBe('—');
    expect(CP1252_HIGH.filter((char) => char === '')).toHaveLength(5);
  });
});

import { type CollectedMeta, resolveHttpUrl, selectFaviconUrl, selectTitleImage } from './select';

// The selection rules every extracting client shares (select.ts's header): the
// extractor's HTMLRewriter and bracemark-expo's regex head scanner collect differently but
// must AGREE on which tag wins, or a tier upgrade rewrites a link's title/image with a
// different tag's value and reads as a change rather than an improvement.

const BASE = new URL('https://example.com/articles/one');

describe('resolveHttpUrl', () => {
  it('resolves a relative url against the page url', () => {
    expect(resolveHttpUrl('/img/a.png', BASE)).toBe('https://example.com/img/a.png');
  });

  it.each([
    ['a data uri', 'data:image/png;base64,iVBORw0KGgo='],
    ['a javascript url', 'javascript:alert(1)'],
    ['an unparseable absolute url', 'http://['],
    ['empty', ''],
  ])('drops %s', (_name, raw) => {
    expect(resolveHttpUrl(raw, BASE)).toBeUndefined();
  });
});

describe('selectTitleImage', () => {
  it('prefers og:title over <title>', () => {
    const collected: CollectedMeta = { ogTitle: 'The OG one', docTitle: 'The doc one' };
    expect(selectTitleImage(collected, BASE).title).toBe('The OG one');
  });

  it('falls back to <title> when there is no og:title', () => {
    expect(selectTitleImage({ docTitle: 'The doc one' }, BASE).title).toBe('The doc one');
  });

  it('normalizes the selected title (cleanTitle) rather than the raw tag', () => {
    expect(selectTitleImage({ docTitle: '  spaced   out\n' }, BASE).title).toBe('spaced out');
  });

  it('leaves the title undefined when the page declares none', () => {
    expect(selectTitleImage({}, BASE).title).toBeUndefined();
  });

  // The documented image order, walked one fallback at a time. Each row carries the
  // winner as `/a.png` plus EVERY lower-priority candidate — without the full set a
  // row only proves "beats the tags that happened to be present", and swapping two
  // rungs of the `??` chain (og:image:url ahead of og:image, say) passes the table.
  it.each([
    [
      'og:image',
      {
        ogImage: '/a.png',
        ogImageUrl: '/other.png',
        ogImageSecure: '/other.png',
        twitterImage: '/other.png',
        imageSrc: '/other.png',
      },
    ],
    [
      'og:image:url',
      {
        ogImageUrl: '/a.png',
        ogImageSecure: '/other.png',
        twitterImage: '/other.png',
        imageSrc: '/other.png',
      },
    ],
    [
      'og:image:secure_url',
      { ogImageSecure: '/a.png', twitterImage: '/other.png', imageSrc: '/other.png' },
    ],
    ['twitter:image', { twitterImage: '/a.png', imageSrc: '/other.png' }],
    ['link rel=image_src', { imageSrc: '/a.png' }],
  ])('picks %s over every lower-priority tag', (_name, collected: CollectedMeta) => {
    expect(selectTitleImage(collected, BASE).imageUrl).toBe('https://example.com/a.png');
  });

  it('drops a non-http(s) image instead of returning it', () => {
    expect(selectTitleImage({ ogImage: 'data:image/png;base64,x' }, BASE).imageUrl).toBeUndefined();
  });
});

describe('selectFaviconUrl', () => {
  const icon = (href: string, rel = 'icon', sizes?: string, type?: string) => ({
    href,
    rel,
    sizes,
    type,
  });

  it('returns undefined when the page declares no icon (caller guesses /favicon.ico)', () => {
    expect(selectFaviconUrl({}, BASE)).toBeUndefined();
    expect(selectFaviconUrl({ icons: [] }, BASE)).toBeUndefined();
  });

  it('picks the smallest icon at least 32px across', () => {
    const icons = [
      icon('/i16.png', 'icon', '16x16'),
      icon('/i512.png', 'icon', '512x512'),
      icon('/i48.png', 'icon', '48x48'),
    ];
    expect(selectFaviconUrl({ icons }, BASE)).toBe('https://example.com/i48.png');
  });

  it('counts an icon exactly at the 32px floor as big enough', () => {
    // The floor is inclusive, and only a pair pins it: make the bound exclusive and
    // the 32px icon is skipped, the 16px one wins as the last resort, and the page
    // that declared a sharp icon shows a soft one. Every other case here passes
    // either way.
    const icons = [icon('/i16.png', 'icon', '16x16'), icon('/i32.png', 'icon', '32x32')];
    expect(selectFaviconUrl({ icons }, BASE)).toBe('https://example.com/i32.png');
  });

  it('prefers an unsized icon over a declared one below the floor', () => {
    // Rung two of the ladder: a below-floor icon is SKIPPED, not ranked, so the plain
    // `rel="icon"` most pages declare beats a 16px sibling rather than losing to it
    // on document order.
    const icons = [icon('/i16.png', 'icon', '16x16'), icon('/plain.png', 'icon')];
    expect(selectFaviconUrl({ icons }, BASE)).toBe('https://example.com/plain.png');
  });

  it('reads the LARGEST dimension a multi-size attribute declares', () => {
    // `sizes="16x16 40x40"` is one 40px icon, not a 16px one — reading the first
    // token instead drops it below the floor and hands the row to the 48px sibling.
    const icons = [icon('/multi.png', 'icon', '16x16 40x40'), icon('/i48.png', 'icon', '48x48')];
    expect(selectFaviconUrl({ icons }, BASE)).toBe('https://example.com/multi.png');
  });

  it('treats sizes="any" as unsized rather than as a size', () => {
    // Scalable, so there is no pixel count to rank — it lands on the unsized rung,
    // ahead of a 16px declaration.
    const icons = [icon('/scalable.png', 'icon', 'any'), icon('/i16.png', 'icon', '16x16')];
    expect(selectFaviconUrl({ icons }, BASE)).toBe('https://example.com/scalable.png');
  });

  it('ignores an icon declared with a blank href', () => {
    // `<link rel="icon" href="">` would otherwise be CHOSEN (first unsized) and then
    // resolve to nothing — undefined returned from a page that declared a usable icon.
    const icons = [icon('  ', 'icon'), icon('/i.png', 'icon')];
    expect(selectFaviconUrl({ icons }, BASE)).toBe('https://example.com/i.png');
  });

  it('prefers an unsized declaration over nothing and resolves it', () => {
    expect(selectFaviconUrl({ icons: [icon('favicon.png', 'shortcut icon')] }, BASE)).toBe(
      'https://example.com/articles/favicon.png',
    );
  });

  it('falls back to a too-small icon rather than a monogram', () => {
    expect(selectFaviconUrl({ icons: [icon('/i16.png', 'icon', '16x16')] }, BASE)).toBe(
      'https://example.com/i16.png',
    );
  });

  it('falls back to apple-touch-icon when it is the only renderable candidate', () => {
    const icons = [icon('/at.png', 'apple-touch-icon', '180x180')];
    expect(selectFaviconUrl({ icons }, BASE)).toBe('https://example.com/at.png');
  });

  // Skipped up front because the fetch could only end in a `none` verdict — the
  // favicon store's byte sniff rejects SVG, so asking for it is a wasted request.
  it.each([
    ['a mask-icon', icon('/pin.svg', 'mask-icon')],
    ['an svg by type', icon('/i', 'icon', undefined, 'image/svg+xml')],
    ['an svg by extension', icon('/i.svg?v=2', 'icon')],
  ])('skips %s', (_name, only) => {
    expect(selectFaviconUrl({ icons: [only] }, BASE)).toBeUndefined();
  });

  it('ignores non-icon rels a parser may have collected', () => {
    const icons = [icon('/style.css', 'stylesheet'), icon('/i.png', 'icon', '32x32')];
    expect(selectFaviconUrl({ icons }, BASE)).toBe('https://example.com/i.png');
  });
});

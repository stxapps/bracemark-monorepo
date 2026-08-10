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

  // The documented image order, walked one fallback at a time.
  it.each([
    ['og:image', { ogImage: '/a.png', twitterImage: '/b.png', imageSrc: '/c.png' }, '/a.png'],
    ['og:image:url', { ogImageUrl: '/a.png', twitterImage: '/b.png' }, '/a.png'],
    ['og:image:secure_url', { ogImageSecure: '/a.png', twitterImage: '/b.png' }, '/a.png'],
    ['twitter:image', { twitterImage: '/b.png', imageSrc: '/c.png' }, '/b.png'],
    ['link rel=image_src', { imageSrc: '/c.png' }, '/c.png'],
  ])('picks %s', (_name, collected: CollectedMeta, expected) => {
    expect(selectTitleImage(collected, BASE).imageUrl).toBe(`https://example.com${expected}`);
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

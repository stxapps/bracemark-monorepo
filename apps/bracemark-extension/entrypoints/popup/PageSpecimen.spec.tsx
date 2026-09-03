import { render, screen } from '@testing-library/react';

import { PageSpecimen } from './PageSpecimen';

// The one object the popup is about, drawn as the library will draw it. Two rules
// here are load-bearing and neither is visible from the component's own file:
//
//   - THE FALLBACK CHAIN, best first: the extracted preview image, then the LIVE
//     TAB's favicon (free from `tabs.query` — no fetch, no host disclosed to
//     anyone), then `HostMonogram`. Getting the order wrong doesn't break the
//     render; it silently downgrades every specimen to a letter tile, or — worse —
//     puts a network favicon fetch on a surface that deliberately makes none.
//   - THE ADDRESS IS TRIMMED, not truncated: `https://` reads on every row and
//     distinguishes nothing, a trailing slash is not part of what anyone
//     recognises, and everything else — `www.` and the path included — stays,
//     because dropping either would show an address that isn't the one being saved.

const image = () => document.querySelector('img[src^="blob:"], img[src^="http"]');
const monogram = () => document.querySelector('svg');

describe('the address line', () => {
  it.each([
    ['https://example.com/posts/one', 'example.com/posts/one'],
    ['http://example.com/posts/one', 'example.com/posts/one'],
    // `www.` and the path stay: an address that isn't the one being saved would be
    // worse than a long one.
    ['https://www.example.com/a/b?q=1', 'www.example.com/a/b?q=1'],
    ['https://example.com/', 'example.com'],
    ['https://example.com', 'example.com'],
  ])('%s reads as %s', (url, expected) => {
    render(<PageSpecimen url={url} title="A page" />);

    expect(screen.getByText(expected)).toBeTruthy();
  });

  it('carries the full URL as a title attribute, for when truncation hides the part that matters', () => {
    const url = 'https://example.com/a/very/long/path?with=query';
    render(<PageSpecimen url={url} title="A page" />);

    expect(screen.getByText('example.com/a/very/long/path?with=query').getAttribute('title')).toBe(
      url,
    );
  });
});

describe('the headline', () => {
  it('shows the title when there is one', () => {
    render(<PageSpecimen url="https://example.com/post" title="The page title" />);

    expect(screen.getByText('The page title')).toBeTruthy();
  });

  it('falls back to the host before the address — a bare host reads as a name', () => {
    render(<PageSpecimen url="https://www.example.com/deep/path" />);

    // `hostFromText` drops the `www.`, so the headline and the address line below
    // it are deliberately not the same string.
    expect(screen.getByText('example.com')).toBeTruthy();
  });

  it('falls back to the address when the URL has no host to name', () => {
    render(<PageSpecimen url="not a url" />);

    // Headline and address line both, since there is nothing else to show.
    expect(screen.getAllByText('not a url')).toHaveLength(2);
  });
});

describe('the tile', () => {
  it('shows the extracted preview image when one has arrived', () => {
    render(
      <PageSpecimen
        url="https://example.com/post"
        title="A page"
        imageUrl="blob:extracted"
        iconUrl="https://example.com/favicon.ico"
      />,
    );

    expect(image()?.getAttribute('src')).toBe('blob:extracted');
    expect(monogram()).toBeNull();
  });

  it('shows the live tab’s favicon when there is no preview image yet', () => {
    render(
      <PageSpecimen
        url="https://example.com/post"
        title="A page"
        iconUrl="https://example.com/favicon.ico"
      />,
    );

    expect(image()?.getAttribute('src')).toBe('https://example.com/favicon.ico');
    expect(monogram()).toBeNull();
  });

  it('falls back to the host monogram when the page offers neither', () => {
    render(<PageSpecimen url="https://example.com/post" title="A page" />);

    expect(image()).toBeNull();
    expect(monogram()).toBeTruthy();
  });

  it('leaves both images out of the accessibility tree — the title beside them is the name', () => {
    render(
      <PageSpecimen url="https://example.com/post" title="A page" imageUrl="blob:extracted" />,
    );

    expect(image()?.getAttribute('alt')).toBe('');
  });
});

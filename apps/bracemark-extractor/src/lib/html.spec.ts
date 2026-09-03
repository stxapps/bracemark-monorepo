import { describe, expect, it } from 'vitest';

import { LINK_TITLE_MAX } from '@stxapps/shared';

import { extractTitleImage } from './html';

// Runs against the REAL `HTMLRewriter` (vitest.config.ts — workerd via miniflare),
// which is the point: the entity behaviour asserted below is the runtime's, not a
// mock's, and it is the opposite of what the DOM does. Everything the rewriter hands
// back is the SOURCE spelling — `text()` chunks because a `<title>` is RCDATA, and
// `getAttribute` too — so this file's job is to decode what the extension gets free.

const BASE = new URL('https://example.test/post');

const bytes = (html: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(html) as Uint8Array<ArrayBuffer>;

describe('extractTitleImage', () => {
  it('decodes entities in the <title> fallback path', async () => {
    // The reported bug: a personal blog with no og:title. The extractor stored the
    // raw `&mdash;`/`&rsquo;` into the library, and cleanTitle only caps length.
    const { title } = await extractTitleImage(
      bytes(
        '<html><head><title>Please stop calling databases CP or AP &mdash; Martin ' +
          'Kleppmann&rsquo;s blog</title></head><body></body></html>',
      ),
      BASE,
    );
    expect(title).toBe('Please stop calling databases CP or AP — Martin Kleppmann’s blog');
  });

  it('decodes entities in og:title, which getAttribute does NOT do here', async () => {
    const { title } = await extractTitleImage(
      bytes(
        '<html><head><meta property="og:title" content="Tom &amp; Jerry&hellip;"></head></html>',
      ),
      BASE,
    );
    expect(title).toBe('Tom & Jerry…');
  });

  it('decodes a numeric reference, including the windows-1252 range', async () => {
    const { title } = await extractTitleImage(
      bytes('<html><head><title>Kleppmann&#146;s blog &#8212; a post</title></head></html>'),
      BASE,
    );
    expect(title).toBe('Kleppmann’s blog — a post');
  });

  it('decodes &amp; in an og:image query string, so the URL we fetch is the real one', async () => {
    const { imageUrl } = await extractTitleImage(
      bytes(
        '<html><head><meta property="og:image" content="https://cdn.test/a.png?w=1200&amp;h=630">' +
          '</head></html>',
      ),
      BASE,
    );
    expect(imageUrl).toBe('https://cdn.test/a.png?w=1200&h=630');
  });

  it('decodes &amp; in a link rel=image_src href', async () => {
    const { imageUrl } = await extractTitleImage(
      bytes('<html><head><link rel="image_src" href="/i.png?a=1&amp;b=2"></head></html>'),
      BASE,
    );
    expect(imageUrl).toBe('https://example.test/i.png?a=1&b=2');
  });

  it('still prefers og:title over <title>, both decoded', async () => {
    const { title } = await extractTitleImage(
      bytes(
        '<html><head><meta property="og:title" content="The OG&nbsp;one">' +
          '<title>The doc&nbsp;one</title></head></html>',
      ),
      BASE,
    );
    // cleanTitle collapses the decoded nbsp along with any other whitespace.
    expect(title).toBe('The OG one');
  });

  it('leaves a bare ampersand in a title alone', async () => {
    const { title } = await extractTitleImage(
      bytes('<html><head><title>Ben & Jerry’s</title></head></html>'),
      BASE,
    );
    expect(title).toBe('Ben & Jerry’s');
  });

  it('decodes after accumulating, and still caps at LINK_TITLE_MAX', async () => {
    // The buffer is joined first and decoded once (html.ts), so a reference is never
    // read half a chunk at a time. The cap is cleanTitle's, applied to the DECODED
    // text — an entity is one character in a title, not six.
    const pad = 'x'.repeat(LINK_TITLE_MAX - 1);
    const { title } = await extractTitleImage(
      bytes(`<html><head><title>${pad}&mdash;overflow</title></head></html>`),
      BASE,
    );
    expect(title).toBe(`${pad}—`);
    expect(title).toHaveLength(LINK_TITLE_MAX);
  });

  it('leaves the title undefined when the page declares none', async () => {
    const { title, imageUrl } = await extractTitleImage(
      bytes('<html><body>hi</body></html>'),
      BASE,
    );
    expect(title).toBeUndefined();
    expect(imageUrl).toBeUndefined();
  });
  // --- what this file COLLECTS ---------------------------------------------
  // WHICH candidate wins is selectTitleImage's job (covered in shared's
  // select.spec.ts). What's asserted here is the collecting half html.ts owns:
  // which attribute a tag is read from, and which occurrence of it counts.

  it('reads a twitter:image declared with `name` rather than `property`', async () => {
    // Twitter/legacy tags use `name`; OpenGraph uses `property`. Reading only one
    // attribute silently loses a whole family of tags, with no parse error.
    const { imageUrl } = await extractTitleImage(
      bytes(
        '<html><head><meta name="twitter:image" content="https://cdn.test/t.png"></head></html>',
      ),
      BASE,
    );
    expect(imageUrl).toBe('https://cdn.test/t.png');
  });

  it('reads the twitter:image:src spelling too', async () => {
    const { imageUrl } = await extractTitleImage(
      bytes(
        '<html><head><meta name="twitter:image:src" content="https://cdn.test/s.png"></head></html>',
      ),
      BASE,
    );
    expect(imageUrl).toBe('https://cdn.test/s.png');
  });

  it('keeps the FIRST occurrence when a page repeats a tag', async () => {
    // Head order ≈ page intent, and a repeated og:image is common (per-locale or
    // per-platform blocks appended later in the head).
    const { title, imageUrl } = await extractTitleImage(
      bytes(
        '<html><head><meta property="og:title" content="First">' +
          '<meta property="og:title" content="Second">' +
          '<meta property="og:image" content="https://cdn.test/1.png">' +
          '<meta property="og:image" content="https://cdn.test/2.png"></head></html>',
      ),
      BASE,
    );
    expect(title).toBe('First');
    expect(imageUrl).toBe('https://cdn.test/1.png');
  });

  it('skips a blank tag so the next candidate still wins', async () => {
    // An empty og:title is common on templated sites. Collecting it would beat
    // the real <title> and leave the link untitled.
    const { title } = await extractTitleImage(
      bytes(
        '<html><head><meta property="og:title" content="   "><title>Doc title</title></head></html>',
      ),
      BASE,
    );
    expect(title).toBe('Doc title');
  });

  it('matches the tag key case-insensitively', async () => {
    const { title } = await extractTitleImage(
      bytes('<html><head><meta property="OG:Title" content="Shouty"></head></html>'),
      BASE,
    );
    expect(title).toBe('Shouty');
  });
});

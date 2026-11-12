import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { readerDocSchema } from '@stxapps/shared';

import {
  decodeHtml,
  MAX_READ_MODE_DEPTH,
  MAX_READ_MODE_ELEMENTS,
  readModeFromHtml,
  withinReadModeBounds,
} from './read-mode';

// Server read mode, in workerd itself — so linkedom and Readability are exercised in the
// runtime they ship to, not in Node. What comes OUT is the point: the same blocks of
// plain text a live-page capture makes, and no markup.

const PROSE =
  'Bookmarks are a pointer, and a pointer is only as good as the page behind it. ' +
  'Pages move, sites close, and articles slip behind a sign-in wall long after the ' +
  'moment someone decided they were worth keeping. A copy of the words is the part ' +
  'that lasts, which is why this paragraph keeps going for a while longer than usual.';

const page = (article: string, head = '<title>A post</title>') =>
  `<!doctype html><html lang="en"><head>${head}</head><body>` +
  `<header><nav><a href="/">Home</a></nav></header>` +
  `<article><h1>A post</h1>${article}</article><footer>© someone</footer></body></html>`;

const FINAL = new URL('https://example.com/blog/post');

describe('readModeFromHtml', () => {
  it('turns an article into a ReaderDoc of numbered plain-text blocks', () => {
    const doc = readModeFromHtml(
      page(`<p>${PROSE}</p><h2>Second</h2><p>${PROSE}</p>`),
      FINAL,
      7,
    )?.doc;

    expect(readerDocSchema.safeParse(doc).success).toBe(true);
    expect(doc).toMatchObject({
      version: 1,
      capturedAt: 7,
      sourceUrl: FINAL.toString(),
      lang: 'en',
    });
    expect(doc?.blocks.map((b) => b.id)).toEqual(doc?.blocks.map((_, i) => `b${i}`));
    expect(doc?.blocks.map((b) => b.kind)).toEqual(
      expect.arrayContaining(['paragraph', 'heading']),
    );
  });

  // The table block is built by the SHARED walker, but over linkedom's DOM here, not a
  // browser's — `children`, `getAttribute('colspan')`, `querySelector('table')` are
  // each a place the two could differ, and a server copy has to read like a page one.
  it('keeps a data table as a rectangular grid, as a live-page capture does', () => {
    const doc = readModeFromHtml(
      page(
        `<p>${PROSE}</p><table><caption>Prices</caption>` +
          `<thead><tr><th>Plan</th><th colspan="2">Price</th></tr></thead>` +
          `<tbody><tr><td>Plus</td><td><p>$48</p><p>a year</p></td><td>USD</td></tr></tbody>` +
          `</table><p>${PROSE}</p>`,
      ),
      FINAL,
    )?.doc;
    const table = doc?.blocks.find((b) => b.kind === 'table');

    expect(readerDocSchema.safeParse(doc).success).toBe(true);
    expect(
      table?.rows?.map((row) =>
        (row.cells ?? []).map((c) => (c.runs ?? []).map((r) => r.text).join('')),
      ),
    ).toEqual([
      ['Plan', 'Price', ''],
      ['Plus', '$48\na year', 'USD'],
    ]);
    expect(table?.rows?.[0].cells?.every((c) => c.header === true)).toBe(true);
    expect(table?.runs).toEqual([{ text: 'Prices' }]);
  });

  it('keeps no markup, and no remote image URL', () => {
    const doc = readModeFromHtml(
      page(
        `<p>${PROSE} <b onclick="steal()">bold</b><script>steal()</script></p>` +
          `<p>${PROSE}<img src="https://tracker.example/p.gif" onerror="steal()" alt="A chart"></p>`,
      ),
      FINAL,
    )?.doc;
    const json = JSON.stringify(doc);
    expect(json).not.toMatch(/steal|<script|onerror|onclick|tracker\.example/);
  });

  // The addresses go to the client BESIDE the document — resolved against the final
  // URL, here over linkedom — and the document itself names a key and nothing else.
  it('hands back each figure’s address beside the document, never inside it', () => {
    const capture = readModeFromHtml(
      page(
        `<p>${PROSE}</p><figure><img src="/img/chart.png" alt="A chart"><figcaption>Fig. 1</figcaption></figure>` +
          `<p><img srcset="https://cdn.example/a-480.jpg 480w, https://cdn.example/a-1200.jpg 1200w" src="https://cdn.example/a-480.jpg"></p>` +
          `<p>${PROSE} <img src="https://cdn.example/emoji.png" alt=":)"> inline</p>` +
          `<p>${PROSE}</p>`,
      ),
      FINAL,
    );

    expect(capture?.images).toEqual([
      { key: 'i0', url: 'https://example.com/img/chart.png' },
      { key: 'i1', url: 'https://cdn.example/a-1200.jpg' },
    ]);
    const figures = capture?.doc.blocks.filter((b) => b.kind === 'figure');
    expect(figures).toMatchObject([
      { text: 'A chart', image: 'i0', runs: [{ text: 'Fig. 1' }] },
      { image: 'i1' },
    ]);
    expect(JSON.stringify(capture?.doc)).not.toMatch(/cdn\.example|chart\.png/);
  });

  it('resolves relative links against the page, or its own <base>', () => {
    const hrefs = (html: string) =>
      readModeFromHtml(html, FINAL)
        ?.doc.blocks.flatMap((b) => b.runs ?? [])
        .map((r) => r.href)
        .filter(Boolean);

    expect(hrefs(page(`<p>${PROSE} <a href="../about">about</a></p><p>${PROSE}</p>`))).toEqual([
      'https://example.com/about',
    ]);
    expect(
      hrefs(
        page(
          `<p>${PROSE} <a href="x">x</a></p><p>${PROSE}</p>`,
          '<base href="/docs/"><title>t</title>',
        ),
      ),
    ).toEqual(['https://example.com/docs/x']);
    // A non-web base is ignored, and a non-web target is dropped.
    expect(
      hrefs(
        page(
          `<p>${PROSE} <a href="x">x</a> <a href="javascript:steal()">bad</a></p><p>${PROSE}</p>`,
          '<base href="javascript:alert(1)//">',
        ),
      ),
    ).toEqual(['https://example.com/blog/x']);
  });

  // ⚠ Readability throws from inside its parse on some trees linkedom builds — an empty
  // or bare-text body leaves no root element. A throw reached the route's catch-all as a
  // TRANSIENT failure, asked again forever with the same answer; it is no article.
  it('answers null, never a throw, for HTML Readability cannot walk', () => {
    expect(readModeFromHtml('', FINAL)).toBeNull();
    expect(readModeFromHtml(PROSE.repeat(3), FINAL)).toBeNull();
  });

  it('answers null for a page with no article', () => {
    expect(readModeFromHtml('<html><body><div id="app"></div></body></html>', FINAL)).toBeNull();
    expect(readModeFromHtml('<html><body><p>Short.</p></body></html>', FINAL)).toBeNull();
  });
});

describe('decodeHtml', () => {
  it('decodes by the header charset, then a meta charset, then UTF-8', () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
    expect(decodeHtml(latin1, 'text/html; charset=ISO-8859-1')).toBe('café');

    const meta = new TextEncoder().encode('<meta charset="utf-8"><p>café</p>');
    expect(decodeHtml(meta, 'text/html')).toContain('café');

    expect(decodeHtml(new TextEncoder().encode('naïve'), null)).toBe('naïve');
    expect(decodeHtml(new TextEncoder().encode('ok'), 'text/html; charset=x-made-up')).toBe('ok');
  });
});

// The page is a stranger's, and Readability on a linkedom tree is super-linear in nesting depth
// (about cubic: 11 KB of nested <div>s took 3 s at depth 800 on Node, and a 1 MB page of nesting
// did not finish). The byte cap bounds what is read, not what it costs, so a document deeper or
// larger than a real page is answered "not an article" before Readability runs. This is workerd.
describe('the work a page may ask of the parse', () => {
  it('answers not-an-article at once for a page nested far past any real one', () => {
    const deep = `<!doctype html><html><body>${'<div>'.repeat(1000)}<p>${PROSE}</p>${'</div>'.repeat(1000)}</body></html>`;

    const started = Date.now();
    const result = readModeFromHtml(deep, FINAL, 7);

    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('answers not-an-article for a page with more elements than a heavy real one', () => {
    const wide = `<!doctype html><html><body>${'<span>x</span>'.repeat(MAX_READ_MODE_ELEMENTS + 1)}<article><p>${PROSE}</p></article></body></html>`;

    expect(readModeFromHtml(wide, FINAL, 7)).toBeNull();
  });

  it('still reads an article wrapped in a realistic stack of containers', () => {
    const wrapped = `<!doctype html><html><body>${'<div>'.repeat(40)}<article><h1>A post</h1><p>${PROSE}</p><p>${PROSE}</p></article>${'</div>'.repeat(40)}</body></html>`;

    expect(readModeFromHtml(wrapped, FINAL, 7)?.doc.blocks.length).toBeGreaterThan(0);
  });

  it('measures depth without recursion, so the page cannot choose the stack', () => {
    const depth = MAX_READ_MODE_DEPTH + 1;
    const { document } = parseHTML(`<html><body>${'<div>'.repeat(depth)}x</body></html>`);

    expect(withinReadModeBounds(document as unknown as { firstElementChild: unknown })).toBe(false);
  });
});

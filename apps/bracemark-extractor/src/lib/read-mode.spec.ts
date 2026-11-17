import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { readerDocSchema } from '@stxapps/shared';

import {
  decodeHtml,
  MAX_READ_MODE_COST,
  MAX_READ_MODE_DEPTH,
  MAX_READ_MODE_ELEMENTS,
  MAX_READ_MODE_NODES,
  readModeFromHtml,
  withinReadModeBounds,
  withinReadModeMarkup,
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

type Walked = Parameters<typeof withinReadModeBounds>[0];

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

    expect(withinReadModeBounds(document as unknown as Walked)).toBe(false);
  });

  // Depth and element count are not a cost bound: the same 5,000 elements at depth 100 cost Readability
  // about 2 s on Node (and at depth 250, 10 s) where a flat page of 5,000 costs milliseconds. What is
  // capped is the sum of depth squared over the elements, plus children squared over the parents.
  it('refuses a page whose depth and element count are each in bounds but whose product is not', () => {
    const body = `${'<div>'.repeat(100)}<p>${PROSE}</p><p>${PROSE}</p>${'<span>a</span>'.repeat(5000)}${'</div>'.repeat(100)}`;
    const html = `<!doctype html><html><body>${body}</body></html>`;
    const { document } = parseHTML(html);
    // Each limit alone is met, and the check before the parse passes.
    expect(5000 + 105).toBeLessThan(MAX_READ_MODE_ELEMENTS);
    expect(withinReadModeMarkup(html)).toBe(true);
    expect(5000 * 101 * 101).toBeGreaterThan(MAX_READ_MODE_COST);

    expect(withinReadModeBounds(document as unknown as Walked)).toBe(false);
    const started = Date.now();
    expect(readModeFromHtml(html, FINAL, 7)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // Width costs too: Readability re-reads a parent's `children` after each sibling it appends to the
  // article, and linkedom builds that list afresh each time, so N siblings cost N squared — 59,000
  // short paragraphs, 2% of the depth-squared cap, took 173 s in workerd.
  it('refuses a parent with more children than the cost allows, though the page is shallow', () => {
    const flat = (n: number) =>
      `<!doctype html><html><body><div id=main><p>${PROSE}</p><p>${PROSE}</p><p>${PROSE}</p></div>${'<p>a. </p>'.repeat(n)}</body></html>`;
    const tree = (html: string) =>
      parseHTML(html).document as unknown as Walked;
    const over = Math.ceil(Math.sqrt(MAX_READ_MODE_COST)) + 1;

    expect(withinReadModeBounds(tree(flat(over)))).toBe(false);
    expect(withinReadModeBounds(tree(flat(over - 200)))).toBe(true);
    const started = Date.now();
    expect(readModeFromHtml(flat(59_000), FINAL, 7)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // Depth alone, with no wide parent: eight leaves at every level of a 250-deep chain.
  it('refuses a page by depth squared alone', () => {
    const html = `<!doctype html><html><body>${('<div>' + '<i></i>'.repeat(8)).repeat(250)}${'</div>'.repeat(250)}</body></html>`;
    const tree = parseHTML(html).document as unknown as Walked;

    expect(withinReadModeMarkup(html)).toBe(true);
    expect(withinReadModeBounds(tree)).toBe(false);
  });

  // linkedom keeps an element's attributes in the same list as its children, and text runs and
  // comments are nodes too, so Readability's walks step through all of them. Counted as elements
  // only, each of these passed: 240 nested divs around a <p> with 5,000 attributes took 2.7 s on
  // Node (155,000 attributes: 207 s in workerd), and 4,900 siblings among 55,000 comments 17 s.
  it.each([
    [
      'attributes deep in the tree',
      `${'<div>'.repeat(240)}<p${Array.from({ length: 5000 }, (_, i) => ` a${i}`).join('')}>${PROSE}</p><p>${PROSE}</p>${'</div>'.repeat(240)}`,
    ],
    [
      'comments among wide siblings',
      `<div id=main><p>${PROSE}</p><p>${PROSE}</p></div>${'<p>a. </p><!----><!----><!----><!---->'.repeat(4900)}`,
    ],
    [
      'attributes on a wide parent',
      `<div${Array.from({ length: 20_000 }, (_, i) => ` a${i}`).join('')}><p>${PROSE}</p>${'<p>a. </p>'.repeat(4000)}</div>`,
    ],
    ['text runs deep in the tree', `${'<section>'.repeat(240)}<p>${PROSE}${'&amp;'.repeat(5000)}</p>${'</section>'.repeat(240)}`],
  ])('weighs the nodes elements carry, not only the elements: %s', (_, body) => {
    const html = `<!doctype html><html><body>${body}</body></html>`;

    expect(withinReadModeMarkup(html)).toBe(true);
    expect(withinReadModeBounds(parseHTML(html).document as unknown as Walked)).toBe(false);
    const started = Date.now();
    expect(readModeFromHtml(html, FINAL, 7)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reads a heavy real-sized page: a few thousand elements about 30 deep', () => {
    const rows = `<div>${'<span>a</span>'.repeat(3)}</div>`.repeat(800);
    const html = `<!doctype html><html><body>${'<div>'.repeat(30)}<article><h1>A post</h1><p>${PROSE}</p><p>${PROSE}</p>${rows}</article>${'</div>'.repeat(30)}</body></html>`;

    expect(readModeFromHtml(html, FINAL, 7)?.doc.blocks.length).toBeGreaterThan(0);
  });
});

// The parse itself (linkedom's `parseHTML`, htmlparser2 underneath) is what a page of absurd nesting
// makes slow, and it runs before any tree exists to walk — 160,000 nested <div>s (950 KB) took 24 s
// to parse — so the same parser counts the nesting first, building nothing, and stops at a limit.
describe('the markup a page may hold before it is parsed', () => {
  it('answers not-an-article at once for 950 KB of nested divs, without parsing them', () => {
    const nested = `<!doctype html><html><body>${'<div>'.repeat(160_000)}x${'</div>'.repeat(160_000)}</body></html>`;
    expect(nested.length).toBeGreaterThan(900_000);

    const started = Date.now();
    expect(withinReadModeMarkup(nested)).toBe(false);
    expect(readModeFromHtml(nested, FINAL, 7)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('counts nesting the way the parser builds it, at the same limit as the tree', () => {
    const nest = (depth: number) =>
      `<html><body>${'<div>'.repeat(depth - 2)}x${'</div>'.repeat(depth - 2)}</body></html>`;
    const tree = (html: string) =>
      parseHTML(html).document as unknown as Walked;

    expect(withinReadModeMarkup(nest(MAX_READ_MODE_DEPTH))).toBe(true);
    expect(withinReadModeBounds(tree(nest(MAX_READ_MODE_DEPTH)))).toBe(true);
    expect(withinReadModeMarkup(nest(MAX_READ_MODE_DEPTH + 1))).toBe(false);
    expect(withinReadModeBounds(tree(nest(MAX_READ_MODE_DEPTH + 1)))).toBe(false);
    // Closes that come between the opens still leave one level per unit.
    const stairs = (depth: number) =>
      `<html><body>${'<i></i><div>'.repeat(depth - 2)}</body></html>`;
    expect(withinReadModeMarkup(stairs(MAX_READ_MODE_DEPTH))).toBe(true);
    expect(withinReadModeMarkup(stairs(MAX_READ_MODE_DEPTH + 1))).toBe(false);
  });

  // Each of these nests in htmlparser2 although a reading of the string says it doesn't: `/>` on an
  // element that isn't void is ignored, `<thead>` and `<colgroup>` never close themselves, and an end
  // tag with nothing of its name open closes nothing. An estimate off the string let ~1 MB of each
  // through, and the parse then took 7 to 11 s in workerd.
  it.each([
    ['<div/>', '`/>` on an element that is not void'],
    ['<div a=/>', 'an unquoted attribute ending in `/`'],
    ['<thead>', 'an element that never closes itself'],
    ['<colgroup>', 'another'],
    ['<div></b>', 'an end tag with nothing of its name open'],
    ['<p><b>', 'an implied close that applies only to the innermost element'],
  ])('refuses %s repeated, which the parser nests (%s)', (unit) => {
    const html = `<!doctype html><html><body>${unit.repeat(Math.floor(1_000_000 / unit.length))}</body></html>`;

    const started = Date.now();
    expect(withinReadModeMarkup(html)).toBe(false);
    expect(readModeFromHtml(html, FINAL, 7)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not count what the parser closes for a page that leaves it open', () => {
    // Void elements, and an `<li>`, `<p>` or `<td>` the next one closes, are not levels.
    const loose =
      '<ul>' +
      '<li>a'.repeat(3000) +
      '</ul>' +
      '<p>x'.repeat(3000) +
      '<br>'.repeat(3000) +
      '<img src=x>'.repeat(3000) +
      '<table>' +
      '<tr><td>a<td>b'.repeat(3000) +
      '</table><!-- c --><!doctype html>';

    expect(withinReadModeMarkup(`<html><body>${loose}</body></html>`)).toBe(true);
    // Upper case, and end tags with nothing open, are read as the parser reads them.
    expect(withinReadModeMarkup('</DIV></div>'.repeat(5000) + '<DIV>'.repeat(10))).toBe(true);
  });

  // An inline element left open inside a block that closes is closed with the block — depth 4 — and
  // an estimate that counted the `<span>` as staying open refused this page.
  it('reads a page whose blocks leave an inline element open', () => {
    const html = page(`<p>${PROSE}</p><p>${PROSE}</p>${'<div class=c><span>x</div>'.repeat(1500)}`);

    expect(withinReadModeMarkup(html)).toBe(true);
    expect(readModeFromHtml(html, FINAL, 7)?.doc.blocks.length).toBeGreaterThan(0);
  });

  it('refuses more text runs and comments than a real page holds', () => {
    // htmlparser2 emits a text run per decoded entity: a megabyte of `&amp;` is 200,000 nodes.
    const body = (unit: string, n: number) => `<html><body><p>${unit.repeat(n)}</p></body></html>`;

    expect(withinReadModeMarkup(body('&amp;', MAX_READ_MODE_NODES - 10))).toBe(true);
    expect(withinReadModeMarkup(body('&amp;', MAX_READ_MODE_NODES + 10))).toBe(false);
    expect(withinReadModeMarkup(body('<!---->', MAX_READ_MODE_NODES + 10))).toBe(false);
    // And the limit itself stays where a page of them is cheap: 120,000 in one parent took 1.1 s.
    expect(withinReadModeMarkup(body('&amp;', 120_000))).toBe(false);
  });

  it('is linear: tags that never close, and a `<` that opens nothing, cost one pass', () => {
    const started = Date.now();
    // 100,000 void tags whose only `>` is the last character: a search for the `>` from each `<`
    // would read the whole string each time.
    expect(withinReadModeMarkup('<br x'.repeat(100_000) + '>')).toBe(true);
    expect(withinReadModeMarkup('<br x'.repeat(100_000))).toBe(true);
    expect(withinReadModeMarkup('< 1 <2 <3 '.repeat(14_000))).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

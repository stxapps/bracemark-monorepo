import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { readerDocSchema } from '@stxapps/shared';
import { type DomNode, readerCaptureFromArticle } from '@stxapps/shared/reader/reader-doc-from-dom';

import {
  decodeHtml,
  defuseForReadability,
  MAX_READ_MODE_COST,
  MAX_READ_MODE_DEPTH,
  MAX_READ_MODE_ELEMENTS,
  MAX_READ_MODE_NODES,
  readabilityMethod,
  readModeFromHtml,
  srcsetBacktracks,
  textSimilarity,
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

const attributes = (n: number) => Array.from({ length: n }, (_, i) => ` a${i}`).join('');

// A Netscape bookmarks file the way the app's export writes one (the measured 10,000-bookmark file's
// shape): folders of three subfolders and their own bookmarks, a tag pair on most, a note on every
// fifth.
function bookmarksExport(count: number): string {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  let n = 0;
  const bookmarks = (k: number) => {
    for (let i = 0; i < k && n < count; i++, n++) {
      const id = n * 48 + 1;
      const tags = n % 4 === 1 ? '' : ` TAGS="tag-${String(n % 40).padStart(2, '0')},tag-07"`;
      lines.push(
        `<DT><A HREF="https://site-${id % 200}.invalid/page/${id}" ADD_DATE="${1793519749 - n * 28800}"${tags}>Measured bookmark ${id}</A>`,
      );
      if (n % 5 === 2) lines.push(`<DD>A note about bookmark ${id}.`);
    }
  };
  for (let folder = 0; n < count; folder++) {
    lines.push(`<DT><H3 ADD_DATE="1793520349">Folder ${folder}</H3>`, '<DL><p>');
    for (let sub = 0; sub < 3; sub++) {
      lines.push(`<DT><H3 ADD_DATE="1793520349">Folder ${folder}.${sub}</H3>`, '<DL><p>');
      bookmarks(250);
      lines.push('</DL><p>');
    }
    bookmarks(250);
    lines.push('</DL><p>');
  }
  lines.push('</DL><p>');
  return lines.join('\n');
}

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
    const tree = (html: string) => parseHTML(html).document as unknown as Walked;
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
    [
      'text runs deep in the tree',
      `${'<section>'.repeat(240)}<p>${PROSE}${'&amp;'.repeat(5000)}</p>${'</section>'.repeat(240)}`,
    ],
  ])('weighs the nodes elements carry, not only the elements: %s', (_, body) => {
    const html = `<!doctype html><html><body>${body}</body></html>`;

    expect(withinReadModeMarkup(html)).toBe(true);
    expect(withinReadModeBounds(parseHTML(html).document as unknown as Walked)).toBe(false);
    const started = Date.now();
    expect(readModeFromHtml(html, FINAL, 7)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // What no walk of nodes sees. Readability copies an element's attributes one by one when it renames
  // it, re-reading a list linkedom rebuilds on every read, so A attributes cost A squared (40,000 on
  // one shallow `<div>`: 135 s in workerd); and it re-reads every element's text whole for each
  // element above it (one 900 KB text run 240 deep: 10.8 s).
  it.each([
    [
      'attributes squared, on elements Readability renames',
      `${`<p>${PROSE}</p>`.repeat(3)}${`<div${attributes(250)}><h3>Heading</h3></div>`.repeat(400)}`,
    ],
    [
      'one long text run deep in the tree',
      `${'<div>'.repeat(240)}<p>${PROSE}</p><p>${'word '.repeat(180_000)}</p>${'</div>'.repeat(240)}`,
    ],
  ])('weighs the work no walk of nodes is: %s', (_, body) => {
    const html = `<!doctype html><html><body>${body}</body></html>`;

    expect(withinReadModeMarkup(html)).toBe(true);
    expect(withinReadModeBounds(parseHTML(html).document as unknown as Walked)).toBe(false);
    const started = Date.now();
    expect(readModeFromHtml(html, FINAL, 7)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('charges text by its depth, so the same megabyte shallower passes', () => {
    const page = (depth: number) =>
      `<!doctype html><html><body>${'<div>'.repeat(depth)}<p>${PROSE}</p><p>${'word '.repeat(180_000)}</p>${'</div>'.repeat(depth)}</body></html>`;
    const tree = (html: string) => parseHTML(html).document as unknown as Walked;

    expect(withinReadModeBounds(tree(page(10)))).toBe(true);
    expect(withinReadModeBounds(tree(page(240)))).toBe(false);
  });

  // The heaviest page on our disk, rebuilt: a 10,000-bookmark export cut at 1 MB, as the route
  // reads it. It weighs about 0.93 of the cap, so a cap lowered far enough to refuse it fails here.
  it('reads the heaviest honest page known, an export of 10,000 bookmarks', () => {
    const html = bookmarksExport(10_000).slice(0, 1_000_000);
    const tree = parseHTML(html).document as unknown as Walked;

    expect(withinReadModeMarkup(html)).toBe(true);
    expect(withinReadModeBounds(tree)).toBe(true);
  });

  it('reads a heavy real-sized page: a few thousand elements about 30 deep', () => {
    const rows = `<div>${'<span>a</span>'.repeat(3)}</div>`.repeat(800);
    const html = `<!doctype html><html><body>${'<div>'.repeat(30)}<article><h1>A post</h1><p>${PROSE}</p><p>${PROSE}</p>${rows}</article>${'</div>'.repeat(30)}</body></html>`;

    expect(readModeFromHtml(html, FINAL, 7)?.doc.blocks.length).toBeGreaterThan(0);
  });
});

// The rest of what was found slow is in single strings — a regex that backtracks, a comparison of
// every word with every other — and is made linear before Readability runs instead of priced.
describe('the strings Readability would read in quadratic time', () => {
  it('compares a title with a heading by the same answer, in linear time', () => {
    // The method replaced is Readability's own, not its API: if an upgrade renames it, this fails.
    const own = readabilityMethod('_textSimilarity');
    expect(typeof own).toBe('function');
    const self = { REGEXPS: { tokenize: /\W+/g } };
    for (const [a, b] of [
      ['A post', 'A post'],
      ['A post about bookmarks', 'Bookmarks: a post'],
      ['The title', 'Something else entirely'],
      ['', 'x'],
      ['x', '   '],
      ['Ça va? Ünïcode — dashes', 'ça VA ünïcode'],
      ['a a a b', 'b b c c c'],
    ]) {
      expect(textSimilarity(a, b)).toBe(own.call(self, a, b) as number);
    }

    // 960 KB of title against a heading of other words: 55 s when each word was looked up in a list.
    const words = (w: string, n: number) => `${w} `.repeat(n);
    const html =
      `<!doctype html><html><head><title>A post</title><meta property="og:title" content="${words('a', 120_000)}"></head>` +
      `<body><h2>${words('b', 120_000)}</h2>${`<p>${PROSE}</p>`.repeat(3)}</body></html>`;
    const started = Date.now();
    readModeFromHtml(html, FINAL, 7);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // Readability replaces a wrapper with its only child and copies the wrapper's attributes onto it, one
  // by one, down the chain: 276 wrappers of 250 attributes over 20-deep chains took 32 s. The
  // wrappers' attributes go first, which changes nothing that comes out.
  it('lets a chain of wrappers carry no attributes down, with the same document out', () => {
    expect(typeof readabilityMethod('_simplifyNestedElements')).toBe('function');
    const chains = (n: number, attrs: number) =>
      `<!doctype html><html><head><title>A post</title></head><body><div id=main>${`<p>${PROSE}</p>`.repeat(3)}` +
      `${`<section class="s" data-x=1${attributes(attrs)}>${'<div class=w data-y=2>'.repeat(20)}<p>${PROSE} <a href="/x">a link</a></p>${'</div>'.repeat(20)}</section>`.repeat(n)}` +
      `</div></body></html>`;

    // What Readability alone makes of an honest one, through the same walker.
    const honest = chains(4, 3);
    const { document } = parseHTML(honest);
    const base = document.createElement('base');
    base.setAttribute('href', FINAL.toString());
    document.head.insertBefore(base, document.head.firstChild);
    const article = new Readability(document as never).parse();
    const parsed = parseHTML(`<!doctype html><html><body>${article?.content}</body></html>`);
    const plain = readerCaptureFromArticle(
      parsed.document.body as unknown as DomNode,
      article as never,
      FINAL.toString(),
      7,
    );
    expect(readModeFromHtml(honest, FINAL, 7)).toEqual(plain);

    const hostile = chains(100, 250);
    expect(withinReadModeMarkup(hostile)).toBe(true);
    expect(withinReadModeBounds(parseHTML(hostile).document as unknown as Walked)).toBe(true);
    const started = Date.now();
    expect(readModeFromHtml(hostile, FINAL, 7)?.doc.blocks.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps an honest srcset, and drops one the regex would retry from every character', () => {
    for (const honest of [
      'a.jpg',
      'a.jpg 1x, b.jpg 2x',
      'a.jpg 1x,b.jpg 2x',
      ' a.jpg  100w ,  b.jpg 200w ',
      '/w_800,q_70/a.jpg 800w, /w_1600,q_70/a.jpg 1600w',
      'data:image/png;base64,iVBORw0KGgo= 1x',
      'a.jpg 1.5x, b.jpg',
      'a.jpg, b.jpg',
      '/w_800,q_70/a.jpg, /w_1600,q_70/b.jpg 2x',
    ]) {
      expect(srcsetBacktracks(honest), honest).toBe(false);
    }
    for (const hostile of ['aaaa b', 'x,aaaa b', 'a.jpg 1x, aaaa b', 'a.jpg 100w 50h']) {
      expect(srcsetBacktracks(hostile), hostile).toBe(true);
    }
    // Against the regex itself, on every short string of its alphabet a seeded walk reaches: a start
    // the regex retried is a non-space character no match covers.
    const retried = (srcset: string) => {
      const regex = /(\S+)(\s+[\d.]+[xw])?(\s*(?:,|$))/g;
      let covered = 0;
      for (let match = regex.exec(srcset); match; match = regex.exec(srcset)) {
        if (/\S/.test(srcset.slice(covered, match.index))) return true;
        covered = regex.lastIndex;
      }
      return /\S/.test(srcset.slice(covered));
    };
    let seed = 7;
    for (let i = 0; i < 20_000; i++) {
      let srcset = '';
      for (let n = (i % 12) + 1; n > 0; n--) {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        srcset += 'a,. 1x\tw'[seed % 8];
      }
      expect(srcsetBacktracks(srcset), JSON.stringify(srcset)).toBe(retried(srcset));
    }

    const { document } = parseHTML(
      `<html><head><meta property="og:   title" content=t></head><body>` +
        `<img id=honest src=a.jpg srcset="a.jpg 1x, b.jpg 2x">` +
        `<img id=hostile src=a.jpg srcset="${'a'.repeat(50)} b">` +
        `<img id=lazy data-srcset="a.jpg 1 ${'a'.repeat(50)} b" data-src="${'x.jpg'.repeat(9)} b" data-ok="a.jpg 1x, b.jpg 2x">` +
        `</body></html>`,
    );
    defuseForReadability(document);

    expect(document.querySelector('meta')?.getAttribute('property')).toBe('og: title');
    expect(document.getElementById('honest')?.getAttribute('srcset')).toBe('a.jpg 1x, b.jpg 2x');
    expect(document.getElementById('hostile')?.hasAttribute('srcset')).toBe(false);
    expect(document.getElementById('hostile')?.getAttribute('src')).toBe('a.jpg');
    const lazy = document.getElementById('lazy');
    expect(lazy?.hasAttribute('data-srcset')).toBe(false);
    expect(lazy?.hasAttribute('data-src')).toBe(false);
    expect(lazy?.getAttribute('data-ok')).toBe('a.jpg 1x, b.jpg 2x');
  });

  // Each of these passed every check and took 24 to 40 s in workerd at 80 to 160 KB.
  it.each([
    ['a srcset', `<img src="a.jpg" srcset="${'a'.repeat(200_000)} b">`],
    ['a lazy image’s srcset', `<img data-x="a.jpg 1 ${'a'.repeat(200_000)} b">`],
    ['a lazy image’s address', `<img data-x="${'x.jpg'.repeat(40_000)} b">`],
    ['a `<pre>` of whitespace', `<pre>${' '.repeat(200_000)}x</pre>`],
  ])('reads %s in linear time', (_, inside) => {
    const html = `<!doctype html><html><head><meta property="${' '.repeat(200_000)}x" content=y></head><body><article>${`<p>${PROSE}</p>`.repeat(3)}<p>${PROSE} ${inside}</p></article></body></html>`;

    const started = Date.now();
    expect(readModeFromHtml(html, FINAL, 7)?.doc.blocks.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(1000);
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
    const tree = (html: string) => parseHTML(html).document as unknown as Walked;

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
    // And the limit itself, in numbers rather than the constant: where a page of them is cheap
    // (120,000 in one parent took 1.1 s), and above the heaviest local page's 19,000.
    expect(withinReadModeMarkup(body('&amp;', 59_990))).toBe(true);
    expect(withinReadModeMarkup(body('&amp;', 60_010))).toBe(false);
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

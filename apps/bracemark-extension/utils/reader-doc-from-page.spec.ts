import { readerDocFromPage } from './reader-doc-from-page';

// The read-mode converter, against jsdom as the page — the same DOM Readability's own
// test suite runs on. What matters is what comes OUT: blocks of plain text, because the
// copy is rendered inside the app that holds the data key, and nothing a page wrote may
// arrive there as markup (shared reader/reader-doc.ts).

// Enough prose for Readability's pre-check (isProbablyReaderable wants a few hundred
// characters of paragraph text) — a real article clears it many times over.
const PROSE =
  'Bookmarks are a pointer, and a pointer is only as good as the page behind it. ' +
  'Pages move, sites close, and articles slip behind a sign-in wall long after the ' +
  'moment someone decided they were worth keeping. A copy of the words is the part ' +
  'that lasts, which is why this paragraph keeps going for a while longer than usual.';

function setArticle(body: string, title = 'A post'): void {
  document.title = title;
  document.head.innerHTML = '';
  document.body.innerHTML = `<header><nav><a href="/">Home</a></nav></header>
    <article><h1>${title}</h1>${body}</article>
    <footer>© someone</footer>`;
}

const kinds = (doc: ReturnType<typeof readerDocFromPage>) => doc?.blocks.map((b) => b.kind);
const texts = (doc: ReturnType<typeof readerDocFromPage>) =>
  doc?.blocks.map((b) => b.text ?? (b.runs ?? []).map((r) => r.text).join(''));

it('turns an article into numbered blocks of plain text', () => {
  setArticle(`<p>${PROSE}</p><h2>Second</h2><p>${PROSE}</p>`);

  const doc = readerDocFromPage(document, 42);

  expect(doc).toMatchObject({ version: 1, capturedAt: 42 });
  expect(kinds(doc)).toEqual(expect.arrayContaining(['paragraph', 'heading']));
  expect(doc?.blocks.map((b) => b.id)).toEqual(doc?.blocks.map((_, i) => `b${i}`));
  expect(texts(doc)).toContain('Second');
});

it('keeps no markup a page wrote — scripts, handlers and tags are gone', () => {
  setArticle(
    `<p>${PROSE} <b onclick="steal()">bold</b><script>steal()</script></p>` +
      `<p>${PROSE}<img src="https://tracker.example/p.gif" onerror="steal()"></p>`,
  );

  const json = JSON.stringify(readerDocFromPage(document));

  expect(json).not.toMatch(/steal|<script|onerror|onclick|tracker\.example/);
});

it('carries inline marks and http(s) links, and drops any other link target', () => {
  setArticle(
    `<p>${PROSE} <strong>strong</strong> <em>em</em> <code>x()</code> ` +
      `<a href="https://example.com/a">ok</a> <a href="javascript:steal()">bad</a></p>`,
  );

  const runs = readerDocFromPage(document)?.blocks.flatMap((b) => b.runs ?? []) ?? [];

  expect(runs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: 'strong', bold: true }),
      expect.objectContaining({ text: 'em', italic: true }),
      expect.objectContaining({ text: 'x()', code: true }),
      expect.objectContaining({ text: 'ok', href: 'https://example.com/a' }),
    ]),
  );
  expect(runs.find((r) => r.text.includes('bad'))?.href).toBeUndefined();
});

it('keeps lists, quotes and code as their own kinds', () => {
  setArticle(
    `<p>${PROSE}</p><ul><li>one</li><li>two<ol><li>nested</li></ol></li></ul>` +
      `<blockquote><p>${PROSE}</p></blockquote><pre>  indented\n    code</pre><p>${PROSE}</p>`,
  );

  const doc = readerDocFromPage(document);
  const items = doc?.blocks.filter((b) => b.kind === 'listItem') ?? [];
  const lineOf = (b: (typeof items)[number]) => (b.runs ?? []).map((r) => r.text).join('');

  expect(items.map((b) => [lineOf(b), b.level, b.ordered])).toEqual([
    ['one', 0, false],
    ['two', 0, false],
    ['nested', 1, true],
  ]);
  expect(kinds(doc)).toContain('quote');
  expect(doc?.blocks.find((b) => b.kind === 'code')?.text).toBe('  indented\n    code');
});

it('stands an image in as a placeholder with its words, never its URL', () => {
  setArticle(
    `<p>${PROSE}</p><figure><img src="https://cdn.example/a.jpg" alt="A chart">` +
      `<figcaption>Figure 1</figcaption></figure><p>${PROSE}</p>`,
  );

  const figure = readerDocFromPage(document)?.blocks.find((b) => b.kind === 'figure');

  expect(figure).toMatchObject({ text: 'A chart', runs: [{ text: 'Figure 1' }] });
  expect(JSON.stringify(figure)).not.toContain('cdn.example');
});

it('answers null for a page that is not an article', () => {
  document.title = 'Shop';
  document.body.innerHTML = '<nav><a href="/a">A</a><a href="/b">B</a></nav><button>Buy</button>';

  expect(readerDocFromPage(document)).toBeNull();
});

it('reads a clone, leaving the live page untouched', () => {
  // Readability mutates the document it is given, and this is the page the user is on.
  setArticle(`<p>${PROSE}</p><p>${PROSE}</p>`);
  const before = document.body.innerHTML;

  readerDocFromPage(document);

  expect(document.body.innerHTML).toBe(before);
});

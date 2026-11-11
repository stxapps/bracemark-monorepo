import { render, screen } from '@testing-library/react';

import type { ReaderDoc } from '@stxapps/shared';

import { ReaderArticle } from './reader-article';

// The reader's renderer. Its safety argument is that a copy's strings reach the DOM
// as TEXT and nothing else (docs/link-extraction-keep.md, the format tripwire), and
// nothing but a test like this one would notice that breaking: a renderer that
// handed a string to innerHTML would draw every ordinary article exactly the same.

const doc = (blocks: ReaderDoc['blocks'], extra: Partial<ReaderDoc> = {}): ReaderDoc => ({
  version: 1,
  capturedAt: 0,
  blocks,
  ...extra,
});

const mount = (d: ReaderDoc) => render(<ReaderArticle doc={d} title="A post" />);

test('markup inside a copy is printed as text, never parsed', () => {
  const { container } = mount(
    doc([
      {
        id: 'b0',
        kind: 'paragraph',
        runs: [{ text: '<img src=x onerror="steal()"><script>steal()</script>' }],
      },
    ]),
  );

  expect(container.querySelector('img, script')).toBeNull();
  expect(screen.getByText(/<img src=x onerror/)).not.toBeNull();
});

test('links only to http(s), with no referrer, in a new tab', () => {
  mount(
    doc([
      {
        id: 'b0',
        kind: 'paragraph',
        runs: [
          { text: 'good', href: 'https://example.com/a' },
          { text: ' bad', href: ['javascript', 'steal()'].join(':') },
        ],
      },
    ]),
  );

  const good = screen.getByRole('link', { name: 'good' });
  expect(good.getAttribute('href')).toBe('https://example.com/a');
  expect(good.getAttribute('rel')).toContain('noreferrer');
  expect(good.getAttribute('target')).toBe('_blank');
  expect(screen.queryByRole('link', { name: /bad/ })).toBeNull();
});

test('the title is the one h1, and the copy’s headings sit below it', () => {
  mount(doc([{ id: 'b0', kind: 'heading', level: 1, runs: [{ text: 'Section' }] }]));

  expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([
    'A post',
  ]);
  expect(screen.getByRole('heading', { level: 2, name: 'Section' })).not.toBeNull();
});

test('consecutive items become one real list', () => {
  mount(
    doc([
      { id: 'b0', kind: 'listItem', ordered: true, level: 0, runs: [{ text: 'one' }] },
      { id: 'b1', kind: 'listItem', ordered: true, level: 0, runs: [{ text: 'two' }] },
    ]),
  );

  const lists = screen.getAllByRole('list');
  expect(lists).toHaveLength(1);
  expect(lists[0].tagName).toBe('OL');
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
});

test('a figure loads nothing — the copy keeps words, not images', () => {
  const { container } = mount(
    doc([{ id: 'b0', kind: 'figure', text: 'A chart', runs: [{ text: 'Figure 1' }] }]),
  );

  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByText('A chart')).not.toBeNull();
  expect(screen.getByText('Figure 1')).not.toBeNull();
});

test('a kept image is drawn from the caller’s map, in a box of its stored size', () => {
  const { container } = render(
    <ReaderArticle
      doc={doc([
        { id: 'b0', kind: 'figure', text: 'A chart', image: 'i0', width: 800, height: 400 },
      ])}
      title="A post"
      images={new Map([['i0', { url: 'blob:kept-i0', width: 800, height: 400 }]])}
    />,
  );

  const img = screen.getByRole('img', { name: 'A chart' });
  expect(img.getAttribute('src')).toBe('blob:kept-i0');
  expect((img.parentElement as HTMLElement).style.aspectRatio).toBe('800 / 400');
  expect(container.querySelectorAll('img')).toHaveLength(1);
});

test('a figure whose pack is still on its way holds its space; settled without it, its words', () => {
  const figure = doc([
    { id: 'b0', kind: 'figure', text: 'A chart', image: 'i0', width: 800, height: 400 },
  ]);

  const waiting = render(
    <ReaderArticle doc={figure} title="A post" images={new Map()} imagesSettled={false} />,
  );
  expect(waiting.container.querySelector('img')).toBeNull();
  expect(waiting.container.querySelector('[style*="aspect-ratio"]')).not.toBeNull();
  expect(screen.queryByText('A chart')).toBeNull();
  waiting.unmount();

  const settled = render(<ReaderArticle doc={figure} title="A post" images={new Map()} />);
  expect(settled.container.querySelector('img')).toBeNull();
  expect(screen.getByText('A chart')).not.toBeNull();
});

test('nothing in a document can name an image address — only a key into the pack', () => {
  // A copy is stored bytes. Whatever a figure block carries, the only `src` this
  // renderer writes is one the caller minted.
  const { container } = render(
    <ReaderArticle
      doc={doc([
        {
          id: 'b0',
          kind: 'figure',
          text: 'x',
          image: 'https://tracker.example/p.gif',
          url: 'https://tracker.example/p.gif',
          src: 'https://tracker.example/p.gif',
          width: 10,
          height: 10,
        },
      ])}
      title="A post"
      images={new Map([['i0', { url: 'blob:kept-i0', width: 10, height: 10 }]])}
    />,
  );

  expect(container.querySelector('img')).toBeNull();
  expect(container.innerHTML).not.toContain('tracker.example');
});

test('a block kind from a newer version is skipped, and the rest still renders', () => {
  mount(
    doc([
      { id: 'b0', kind: 'poll', options: [['x']] },
      { id: 'b1', kind: 'paragraph', runs: [{ text: 'still here' }] },
    ]),
  );

  expect(screen.getByText('still here')).not.toBeNull();
});

test('a table is a real table: header cells scoped, the caption its name', () => {
  mount(
    doc([
      {
        id: 'b0',
        kind: 'table',
        runs: [{ text: 'Prices' }],
        rows: [
          {
            cells: [
              { runs: [{ text: 'Plan' }], header: true },
              { runs: [{ text: 'Price' }], header: true },
            ],
          },
          {
            cells: [{ runs: [{ text: 'Plus' }], header: true }, { runs: [{ text: '<b>$48</b>' }] }],
          },
        ],
      },
    ]),
  );

  const table = screen.getByRole('table', { name: 'Prices' });
  expect(table.querySelector('b')).toBeNull();
  expect(screen.getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Plan', 'Price']);
  expect(screen.getByRole('rowheader', { name: 'Plus' })).not.toBeNull();
  expect(screen.getByRole('cell', { name: '<b>$48</b>' })).not.toBeNull();
  // The scroller is what a keyboard reaches, so a wide table can be scrolled.
  expect(screen.getByRole('region', { name: 'Prices' }).getAttribute('tabindex')).toBe('0');
});

test('a table that was cut says so, and one with no readable rows renders nothing', () => {
  const { container } = mount(
    doc([
      {
        id: 'b0',
        kind: 'table',
        truncated: true,
        rows: [{ cells: [{ runs: [{ text: 'a' }] }, { runs: [{ text: 'b' }] }] }],
      },
      // Stored bytes are not trusted to be the shape the capture writes.
      { id: 'b1', kind: 'table', rows: [['x'], null, { cells: 'no' }] } as never,
    ]),
  );

  expect(screen.getByText('The rest of this table wasn’t kept.')).not.toBeNull();
  expect(container.querySelectorAll('table')).toHaveLength(1);
});

test('direction and language come from the copy', () => {
  const { container } = mount(doc([], { dir: 'rtl', lang: 'ar' }));
  const article = container.querySelector('article');
  expect(article?.getAttribute('dir')).toBe('rtl');
  expect(article?.getAttribute('lang')).toBe('ar');
});

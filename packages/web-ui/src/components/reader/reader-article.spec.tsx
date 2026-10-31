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

test('a block kind from a newer version is skipped, and the rest still renders', () => {
  mount(
    doc([
      { id: 'b0', kind: 'table', rows: [['x']] },
      { id: 'b1', kind: 'paragraph', runs: [{ text: 'still here' }] },
    ]),
  );

  expect(screen.getByText('still here')).not.toBeNull();
});

test('direction and language come from the copy', () => {
  const { container } = mount(doc([], { dir: 'rtl', lang: 'ar' }));
  const article = container.querySelector('article');
  expect(article?.getAttribute('dir')).toBe('rtl');
  expect(article?.getAttribute('lang')).toBe('ar');
});

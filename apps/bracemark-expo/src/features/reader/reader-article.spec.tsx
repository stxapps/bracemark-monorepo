import * as React from 'react';
import { Linking } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import type { ReaderDoc } from '@stxapps/shared';

import { ReaderArticle } from './reader-article';

// The native reader's renderer. Its strings become `<Text>` and nothing interprets
// them; what's left to pin is the rest of the contract the web twin's spec pins:
// links only to http(s), unknown kinds skipped without blanking the copy, and the
// ordering a screen reader and a reader both rely on.

const doc = (blocks: ReaderDoc['blocks'], extra: Partial<ReaderDoc> = {}): ReaderDoc => ({
  version: 1,
  capturedAt: 0,
  blocks,
  ...extra,
});

const mount = (d: ReaderDoc) => render(<ReaderArticle doc={d} title="A post" />);

beforeEach(() => {
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());

test('prints markup in a copy as text', () => {
  mount(doc([{ id: 'b0', kind: 'paragraph', runs: [{ text: '<b>not bold</b>' }] }]));
  expect(screen.getByText('<b>not bold</b>')).toBeTruthy();
});

test('opens an http(s) link, and makes nothing of any other target', () => {
  mount(
    doc([
      {
        id: 'b0',
        kind: 'paragraph',
        runs: [
          { text: 'good', href: 'https://example.com/a' },
          { text: 'bad', href: ['javascript', 'steal()'].join(':') },
        ],
      },
    ]),
  );

  fireEvent.press(screen.getByText('good'));
  expect(Linking.openURL).toHaveBeenCalledWith('https://example.com/a');
  expect(screen.getByText('bad').props.onPress).toBeUndefined();
});

test('numbers each run of ordered items from 1', () => {
  mount(
    doc([
      { id: 'b0', kind: 'listItem', ordered: true, level: 0, runs: [{ text: 'one' }] },
      { id: 'b1', kind: 'listItem', ordered: true, level: 0, runs: [{ text: 'two' }] },
      { id: 'b2', kind: 'paragraph', runs: [{ text: 'between' }] },
      { id: 'b3', kind: 'listItem', ordered: true, level: 0, runs: [{ text: 'again' }] },
    ]),
  );
  // The markers are hidden from assistive tech (the item text carries the content),
  // so the query has to ask for hidden elements.
  const markers = screen.getAllByText(/^\d\.$/, { includeHiddenElements: true });
  expect(markers.map((n) => n.props.children)).toEqual(['1.', '2.', '1.']);
});

test('a block kind from a newer version is skipped, and the rest still renders', () => {
  mount(
    doc([
      { id: 'b0', kind: 'table', rows: [['x']] },
      { id: 'b1', kind: 'paragraph', runs: [{ text: 'still here' }] },
    ]),
  );
  expect(screen.getByText('still here')).toBeTruthy();
});

test('a figure is its words, not an image', () => {
  mount(doc([{ id: 'b0', kind: 'figure', text: 'A chart', runs: [{ text: 'Figure 1' }] }]));
  expect(screen.getByText('A chart')).toBeTruthy();
  expect(screen.getByText('Figure 1')).toBeTruthy();
  expect(screen.queryByRole('image')).toBeNull();
});

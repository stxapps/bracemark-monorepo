import { act, fireEvent, render, screen } from '@testing-library/react';

import { buildTree, type TagItem } from '@stxapps/shared';
import { type LinkView, useTags } from '@stxapps/web-react';

import { BulkTagsDialog } from './bulk-tags-dialog';

// The drift guard for a ported pair, not a second copy of the protocol
// (docs/testing.md, _the ported pair_). `bulk-tags-dialog.tsx` is duplicated
// SOURCE — this file and bracemark-expo's `features/links/bulk-tags-dialog.tsx`
// — and the expo spec beside it is canonical for the diff semantics: the seed,
// the per-link patch, the pending save, the link already in the target state
// that gets no write. None of that is re-asserted here. What IS asserted is the
// one rule whose violation on THIS platform nothing else in the workspace can
// see, and it is silent in the worst way: replace the `flatMap` below with the
// obvious `links.map((link) => ({ link, patch: { tagIds } }))` and the app still
// lints, still typechecks, still passes every expo case — and every bulk edit
// quietly strips the tags only SOME of the selected links carried, which the
// user was never shown and so cannot know to restore.
//
// `@stxapps/web-react` is mocked at the barrel — the real hooks are Dexie
// liveQueries over an encrypted local store — and that single mock also feeds
// the real `TagsCommand` this dialog renders, so the rows are the app's rows.
// The picker's own rules (filtering, minting, which row reports a toggle) are
// `web-ui`'s `tags-command.spec.tsx`, one layer down.

const mockCloseRetag = jest.fn();
const mockExitBulkEdit = jest.fn();
const mockUpdateMany = jest.fn();
const mockFindOrCreate = jest.fn();
let mockRetagging: LinkView[] | null = null;

jest.mock('@stxapps/web-react', () => ({
  useTags: jest.fn(),
  useLinkMutations: () => ({ updateMany: mockUpdateMany }),
  useTagMutations: () => ({ findOrCreate: mockFindOrCreate }),
}));

jest.mock('../_contexts/view-state-provider', () => ({
  useLinksViewState: () => ({
    retagging: mockRetagging,
    closeRetag: mockCloseRetag,
    exitBulkEdit: mockExitBulkEdit,
  }),
}));

// cmdk observes its list and scrolls the active row into view, and Radix's
// dismiss layer reaches for pointer capture; jsdom implements none of it. Seams,
// not subjects — nothing below asserts on a measurement.
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe = () => undefined;
    unobserve = () => undefined;
    disconnect = () => undefined;
  };
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
});

let clock = 0;
const tag = (id: string, name: string): TagItem => ({
  id,
  name,
  parentId: null,
  rank: `a${(clock++).toString().padStart(3, '0')}`,
  createdAt: 0,
  updatedAt: 0,
  path: `tags/${id}.enc`,
});

// A link carrying a tag every selected link has, and one only it has.
const link = (path: string, tagIds: string[]) => ({ path, tagIds }) as unknown as LinkView;
const A = link('a', ['only-a', 'common']);
const B = link('b', ['common', 'only-b']);

const row = (name: string) => screen.getByRole('option', { name });
const save = () => screen.getByRole('button', { name: 'Save' });

beforeEach(() => {
  clock = 0;
  mockRetagging = [A, B];
  mockCloseRetag.mockClear();
  mockExitBulkEdit.mockClear();
  mockUpdateMany.mockReset().mockResolvedValue(undefined);
  mockFindOrCreate.mockReset();
  (useTags as jest.Mock).mockReturnValue(
    buildTree([tag('only-a', 'Only A'), tag('common', 'Common'), tag('only-b', 'Only B')]),
  );
});

test('starts with only tags shared by every selected link checked', () => {
  render(<BulkTagsDialog />);

  // The intersection, and nothing else: a tag on just one of the two is not
  // shown as selected, which is what makes the diff below safe to apply.
  expect(row('Only A').getAttribute('aria-checked')).toBe('false');
  expect(row('Common').getAttribute('aria-checked')).toBe('true');
  expect(row('Only B').getAttribute('aria-checked')).toBe('false');
});

test('applies the visible diff per link without stripping partial tags', async () => {
  render(<BulkTagsDialog />);

  // Remove the shared tag and add one that only A carried before the edit.
  fireEvent.click(row('Common'));
  fireEvent.click(row('Only A'));
  await act(async () => {
    fireEvent.click(save());
  });

  // Each link resolves the same diff against its OWN tags: `common` goes from
  // both, `only-a` is added to both, and `only-b` — which the dialog never
  // showed as selected — survives on B.
  expect(mockUpdateMany).toHaveBeenCalledWith([
    { link: A, patch: { tagIds: ['only-a'] } },
    { link: B, patch: { tagIds: ['only-b', 'only-a'] } },
  ]);
  // The positive control for the negative above: the write that SHOULD happen
  // lands, and the dialog and bulk mode both close once it has.
  expect(mockCloseRetag).toHaveBeenCalledTimes(1);
  expect(mockExitBulkEdit).toHaveBeenCalledTimes(1);
});

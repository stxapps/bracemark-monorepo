// The share pickers mount the rows on screen, not the library (share-picker-list.tsx).
// The cost of the alternative is invisible here — jest has no memory cap, and a
// ScrollView of 300 rows renders fine — and on an iPhone it was the share
// extension killed at 120 MB (docs/share-sheet.md, _300 lists and 300 tags, and
// a copy at the cap_). So this pins the one structural fact that prevents it: at
// a library far past a screenful, only a window of rows exists.

import { render } from '@testing-library/react-native';

import type { ShareTaxonomyList, ShareTaxonomyTag } from '@stxapps/expo-react/data/share-store';

import { ShareListPicker } from './share-list-picker';
import { ShareTagsPicker } from './share-tags-picker';

jest.mock('./share-swipe-guard', () => ({ ShareSwipeGuard: () => null }));

const COUNT = 300;
// Generous: the window is ~12 rows at mount; anything near COUNT means every row.
const WINDOW_MAX = 60;

const lists: ShareTaxonomyList[] = Array.from({ length: COUNT }, (_, i) => ({
  id: `list-${i}`,
  name: `List ${i}`,
  rank: `a${i}`,
  depth: i % 3,
}));
const tags: ShareTaxonomyTag[] = Array.from({ length: COUNT }, (_, i) => ({
  id: `tag-${i}`,
  name: `Tag ${i}`,
  rank: `a${i}`,
}));

test('the list picker mounts a window of a 300-list library, not every row', () => {
  const { queryAllByTestId } = render(
    <ShareListPicker
      lists={lists}
      newList={null}
      selectedId="list-0"
      onSelect={jest.fn()}
      onCreateName={jest.fn()}
      onDone={jest.fn()}
    />,
  );
  const mounted = queryAllByTestId(/^share-list-list-/).length;
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(WINDOW_MAX);
});

test('the tags picker mounts a window of a 300-tag library, not every row', () => {
  const { queryAllByTestId } = render(
    <ShareTagsPicker
      tags={tags}
      selectedTagIds={[]}
      newTags={[]}
      onToggle={jest.fn()}
      onRemoveNew={jest.fn()}
      onSubmitName={jest.fn()}
      onDone={jest.fn()}
    />,
  );
  const mounted = queryAllByTestId(/^share-tag-tag-/).length;
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(WINDOW_MAX);
});

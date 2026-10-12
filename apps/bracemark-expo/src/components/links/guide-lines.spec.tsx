import * as React from 'react';
import { render } from '@testing-library/react-native';

import { TREE_ROW_MAX_LEVELS } from '@stxapps/shared';

import { GuideLines } from './guide-lines';

// One view per level, in a picker that mounts EVERY row (both list pickers are a
// ScrollView over a `.map`, not a virtualized list). So the lines are the one
// part of a row whose cost is its depth, and a tree's depth is not this device's
// to decide: a restored backup keeps `parentId` verbatim and another device can
// sync any chain. A chain of a few thousand lists asked for millions of native
// views here, in the in-app picker and in the share sheet alike — the second
// being the process with the least memory to give (docs/share-sheet.md).

const lineCount = (depth: number) => {
  const tree = render(<GuideLines depth={depth} />).toJSON();
  if (tree === null || Array.isArray(tree)) throw new Error('expected one host view');
  return tree.children?.length ?? 0;
};

// The control first: under the bound the indent IS the lines, one per level —
// a component that drew a fixed handful would pass the case below.
test('draws one line per level', () => {
  expect(lineCount(1)).toBe(1);
  expect(lineCount(3)).toBe(3);
  expect(lineCount(TREE_ROW_MAX_LEVELS)).toBe(TREE_ROW_MAX_LEVELS);
});

test('stops at the row bound however deep the row is', () => {
  expect(lineCount(TREE_ROW_MAX_LEVELS + 1)).toBe(TREE_ROW_MAX_LEVELS);
  expect(lineCount(50_000)).toBe(TREE_ROW_MAX_LEVELS);
});

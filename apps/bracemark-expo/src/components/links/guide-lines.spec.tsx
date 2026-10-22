import * as React from 'react';
import { render, screen } from '@testing-library/react-native';

import { TREE_INDENT_MAX_LEVELS_NARROW } from '@stxapps/shared';

import { GuideLines } from './guide-lines';

// One view per level, in a picker that mounts EVERY row (both list pickers are a
// ScrollView over a `.map`, not a virtualized list). So the lines are the one
// part of a row whose cost is its depth, and a tree's depth is not this device's
// to decide: a restored backup keeps `parentId` verbatim and another device can
// sync any chain. A chain of a few thousand lists asked for millions of native
// views here, in the in-app picker and in the share sheet alike — the second
// being the process with the least memory to give (docs/share-sheet.md).
//
// And the lines are WIDTH: at 24 a level, more than four left a picker row's
// name nothing (@stxapps/shared sync/tree.ts, TREE_INDENT_MAX_LEVELS_NARROW).
// Past them the row numbers its level instead (tree-level.tsx).

const LEVELS = TREE_INDENT_MAX_LEVELS_NARROW;

// The lines are the group's bordered children; the level marker, when there is
// one, is the one child that holds text.
const lineCount = (depth: number) => {
  const tree = render(<GuideLines depth={depth} />).toJSON();
  if (tree === null || Array.isArray(tree)) throw new Error('expected one host view');
  const children: ReadonlyArray<string | { children: unknown[] | null }> = tree.children ?? [];
  return children.filter((child) => typeof child !== 'string' && !child.children?.length).length;
};

// The control first: under the bound the indent IS the lines, one per level —
// a component that drew a fixed handful would pass the case below.
test('draws one line per level, and no number, within the ceiling', () => {
  expect(lineCount(1)).toBe(1);
  expect(lineCount(3)).toBe(3);
  expect(lineCount(LEVELS)).toBe(LEVELS);
  render(<GuideLines depth={LEVELS} />);
  expect(screen.queryByText(String(LEVELS + 1), { includeHiddenElements: true })).toBeNull();
});

test('stops at the ceiling however deep the row is, and numbers its level', () => {
  expect(lineCount(LEVELS + 1)).toBe(LEVELS);
  expect(lineCount(50_000)).toBe(LEVELS);
  // `depth + 1`: the user-facing level, counted from 1 at the top.
  render(<GuideLines depth={LEVELS + 1} />);
  expect(screen.getByText(String(LEVELS + 2), { includeHiddenElements: true })).toBeTruthy();
});

import * as React from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { PortalHost } from '@rn-primitives/portal';
import { render, screen } from '@testing-library/react-native';

import { Peek, type PeekAnchor } from './peek';

// The hold-to-read bubble's placement (peek.tsx). It is laid out by numbers
// alone — no measure of its own, no layout pass to correct it — so a wrong sum
// is a bubble under the finger, off the top of the window or into a notch, and
// nothing reports it. The links rail's spec covers the hold itself
// (features/links/sidebar.spec.tsx); this pins the arithmetic, including the two
// branches a rail row in the middle of an iPad never reaches: a row too near
// the top to fit the bubble above it, and a row starting inside the left inset.
//
// The safe-area mock's frame is 320×640 (testing/setup.ts).

const hidden = { includeHiddenElements: true };

type Insets = { top: number; right: number; bottom: number; left: number };
const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

function mount(anchor: PeekAnchor | null, insets = NO_INSETS, detail?: string) {
  return render(
    <SafeAreaInsetsContext.Provider value={insets}>
      <Peek anchor={anchor} title="A very long list name" detail={detail} />
      <PortalHost />
    </SafeAreaInsetsContext.Provider>,
  );
}

// The absolutely placed box around the title.
function bubbleStyle() {
  let node: ReturnType<typeof screen.getByText> | null = screen.getByText(
    'A very long list name',
    hidden,
  );
  while (node && StyleSheet.flatten(node.props.style)?.position !== 'absolute') node = node.parent;
  return StyleSheet.flatten(node?.props.style);
}

it('renders nothing while no row is held', () => {
  mount(null);
  expect(screen.queryByText('A very long list name', hidden)).toBeNull();
});

it('sits above the row, so the finger holding it does not cover it', () => {
  mount({ x: 16, y: 300, width: 200, height: 36 });
  expect(bubbleStyle()).toMatchObject({ left: 16, bottom: 640 - 300 + 4 });
  expect(bubbleStyle()?.top).toBeUndefined();
});

// Two lines at the capped font scale need 88 above the row, counted from below
// the top inset; a row nearer the top than that gets the bubble below it.
it('drops below a row too near the top to fit above it', () => {
  mount({ x: 16, y: 120, width: 200, height: 36 }, { ...NO_INSETS, top: 47 });
  expect(bubbleStyle()).toMatchObject({ top: 120 + 36 + 4 });
  expect(bubbleStyle()?.bottom).toBeUndefined();

  // …and right at the line, above.
  screen.unmount();
  mount({ x: 16, y: 47 + 88, width: 200, height: 36 }, { ...NO_INSETS, top: 47 });
  expect(bubbleStyle()?.bottom).toBe(640 - (47 + 88) + 4);
});

// A landscape iPhone's rail starts at x 0, under the notch: the bubble starts
// clear of the inset, and its width stops short of the right one.
it('keeps clear of the side insets', () => {
  mount({ x: 0, y: 300, width: 200, height: 36 }, { ...NO_INSETS, left: 59, right: 59 });
  expect(bubbleStyle()).toMatchObject({ left: 59 + 8, maxWidth: 320 - (59 + 8) - 59 - 8 });
});

it('names the path on a second line only when there is one', () => {
  mount({ x: 16, y: 300, width: 200, height: 36 }, NO_INSETS, 'Work › Cooking');
  expect(screen.getByText('Work › Cooking', hidden)).toBeTruthy();
});

// A second copy of a label the row already announces whole would be read twice.
it('is hidden from screen readers', () => {
  mount({ x: 16, y: 300, width: 200, height: 36 });
  expect(screen.queryByText('A very long list name')).toBeNull();
});

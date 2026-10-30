import * as React from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { PortalHost } from '@rn-primitives/portal';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { Peek, type PeekAnchor } from './peek';

// The hold-to-read bubble's placement (peek.tsx). Its side of the row comes from
// its own measured height, so a wrong sum is a bubble under the finger, off the
// top of the window or into a notch, and nothing reports it. The links rail's
// spec covers the hold itself (features/links/sidebar.spec.tsx); this pins the
// arithmetic, including the branches a rail row in the middle of an iPad never
// reaches: a bubble too tall to fit above its row, one that fits neither side,
// and a row starting inside the left inset. jest runs no layout pass, so each
// case reports the bubble's height itself (`layout`).
//
// The safe-area mock's frame is 320×640 (testing/setup.ts).

const hidden = { includeHiddenElements: true };

type Insets = { top: number; right: number; bottom: number; left: number };
const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

const TITLE = 'A very long list name';

function tree(anchor: PeekAnchor | null, insets: Insets, detail?: string, title = TITLE) {
  return (
    <SafeAreaInsetsContext.Provider value={insets}>
      <Peek anchor={anchor} title={title} detail={detail} />
      <PortalHost />
    </SafeAreaInsetsContext.Provider>
  );
}

function mount(anchor: PeekAnchor | null, insets = NO_INSETS, detail?: string) {
  return render(tree(anchor, insets, detail));
}

// The absolutely placed box around the title.
function bubble(title = TITLE) {
  let node: ReturnType<typeof screen.getByText> | null = screen.getByText(title, hidden);
  while (node && StyleSheet.flatten(node.props.style)?.position !== 'absolute') node = node.parent;
  return node!;
}

function bubbleStyle(title = TITLE) {
  return StyleSheet.flatten(bubble(title).props.style);
}

// What a device's layout pass would report for the bubble.
function layout(height: number, title = TITLE) {
  fireEvent(bubble(title), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 200, height } } });
}

it('renders nothing while no row is held', () => {
  mount(null);
  expect(screen.queryByText('A very long list name', hidden)).toBeNull();
});

// Its first frame only lays it out: the height that picks a side isn't known
// until then.
it('stays invisible until it has measured itself', () => {
  mount({ x: 16, y: 300, width: 200, height: 36 });
  expect(bubbleStyle()).toMatchObject({ opacity: 0 });
  layout(54);
  expect(bubbleStyle()).toMatchObject({ opacity: 1 });
});

it('sits above the row, so the finger holding it does not cover it', () => {
  mount({ x: 16, y: 300, width: 200, height: 36 });
  layout(54);
  expect(bubbleStyle()).toMatchObject({ left: 16, bottom: 640 - 300 + 4 });
  expect(bubbleStyle()?.top).toBeUndefined();
});

// Above needs the bubble's height, plus the gap and an edge, under the top
// inset. A tall bubble — a long name wraps to five lines on a phone — over a
// row that fits two lines above it would run up under the status bar.
it('drops below a row when the bubble is too tall to fit above it', () => {
  const insets = { ...NO_INSETS, top: 47 };
  mount({ x: 16, y: 140, width: 200, height: 36 }, insets);
  layout(120);
  expect(bubbleStyle()).toMatchObject({ top: 140 + 36 + 4 });
  expect(bubbleStyle()?.bottom).toBeUndefined();

  // …and a bubble that just fits, above.
  screen.unmount();
  mount({ x: 16, y: 140, width: 200, height: 36 }, insets);
  layout(140 - 4 - 47 - 8);
  expect(bubbleStyle()?.bottom).toBe(640 - 140 + 4);
});

// Taller than either side can hold (a huge font scale): the roomier side.
it('takes the side with more room when it fits neither', () => {
  mount({ x: 16, y: 400, width: 200, height: 36 });
  layout(500);
  expect(bubbleStyle()?.bottom).toBe(640 - 400 + 4);

  screen.unmount();
  mount({ x: 16, y: 200, width: 200, height: 36 });
  layout(500);
  expect(bubbleStyle()?.top).toBe(200 + 36 + 4);
});

// The height belongs to the label, not the row: holding the same row again is
// placed at once, a different label is measured afresh.
it('measures each label once', () => {
  const anchor = { x: 16, y: 300, width: 200, height: 36 };
  mount(anchor);
  layout(54);
  screen.rerender(tree(null, NO_INSETS));
  screen.rerender(tree({ ...anchor }, NO_INSETS));
  expect(bubbleStyle()).toMatchObject({ opacity: 1 });

  screen.rerender(tree({ ...anchor }, NO_INSETS, undefined, 'Another list'));
  expect(bubbleStyle('Another list')).toMatchObject({ opacity: 0 });
});

// A landscape iPhone's rail starts at x 0, under the notch: the bubble starts
// clear of the inset, and its width stops short of the right one.
it('keeps clear of the side insets', () => {
  mount({ x: 0, y: 300, width: 200, height: 36 }, { ...NO_INSETS, left: 59, right: 59 });
  layout(54);
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

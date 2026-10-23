// The in-app sheet's contract with its bodies (components/ui/sheet.tsx). The add
// panel, the link editor and Advanced Search all lean on the same three
// promises, and each is silent when broken:
//
//   - the ✕ is DELIBERATE and Android's back is ACCIDENTAL — a dirty editor
//     guards the second by swallowing it, so the two must reach different
//     callbacks, or the ✕ goes dead exactly when it is wanted (docs/editors.md,
//     invariant 3);
//   - while a sheet is open the subtree it covers leaves the accessibility tree,
//     which is SheetCovered's job and nothing else's;
//   - a sheet outside a SheetHost has no box to cover and no count to raise —
//     it would draw over whatever its parent happens to be and hide nothing —
//     so it must throw instead;
//   - Android's back reaches the sheet only while it is the thing on screen and
//     only after anything opened over it — a picker, registered later, answers
//     first however often the body re-renders, and a covering route or a relock
//     gets the press instead.
//
// The geometry (the avoider, the reveal, the swipe) is a device behaviour
// (docs/soft-keyboard.md, _the in-app sheet_); none of it is asserted here.

import * as React from 'react';
import { BackHandler, Text, View } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { AppCover } from '../../contexts/app-cover';
import type { FocusedFieldReveal } from '../../lib/use-focused-field-reveal';
import { Sheet, SheetCovered, SheetHost, useSheetOpen } from './sheet';

// Whether the links route is the one on screen — false once another route
// (Subscription, Settings) is pushed over it with the sheet still mounted.
let mockFocused = true;
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useIsFocused: () => mockFocused,
}));

// The reveal's worklets need a mounted native scroller; the shell only passes
// its handles through.
const reveal = {
  scrollRef: React.createRef(),
  onScroll: jest.fn(),
  content: React.createRef(),
  onFieldFocus: jest.fn(),
  onFieldBlur: jest.fn(),
  onContentLayout: jest.fn(),
} as unknown as FocusedFieldReveal;

let backListeners: (() => boolean | null | undefined)[] = [];

beforeEach(() => {
  mockFocused = true;
  backListeners = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, listener) => {
    backListeners.push(listener);
    return { remove: () => (backListeners = backListeners.filter((l) => l !== listener)) };
  });
});

afterEach(() => jest.restoreAllMocks());

function renderSheet(open: boolean, onClose = jest.fn(), onDismiss = jest.fn()) {
  const tree = (isOpen: boolean) => (
    <SheetHost>
      <SheetCovered>
        <View testID="covered" />
      </SheetCovered>
      {isOpen && (
        <Sheet
          title="Edit link"
          closeLabel="Close edit link"
          onClose={onClose}
          onDismiss={onDismiss}
          reveal={reveal}
        >
          <Text>body</Text>
        </Sheet>
      )}
    </SheetHost>
  );
  const utils = render(tree(open));
  return {
    ...utils,
    rerenderOpen: (isOpen: boolean) => utils.rerender(tree(isOpen)),
    onClose,
    onDismiss,
  };
}

it('sends the ✕ to onClose and Android back to onDismiss, and consumes the back press', () => {
  const { onClose, onDismiss } = renderSheet(true);

  fireEvent.press(screen.getByLabelText('Close edit link'));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onDismiss).not.toHaveBeenCalled();

  // Consumed whatever the caller does with it, so it never falls through to
  // the navigator and pops the links screen out from under the sheet.
  expect(backListeners.at(-1)?.()).toBe(true);
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('keeps a picker opened over it answering back first, across body re-renders', () => {
  const tree = (onDismiss: () => void) => (
    <SheetHost>
      <Sheet
        title="Edit link"
        closeLabel="Close edit link"
        onClose={jest.fn()}
        onDismiss={onDismiss}
        reveal={reveal}
      >
        <Text>body</Text>
      </Sheet>
    </SheetHost>
  );
  const first = jest.fn();
  const { rerender } = render(tree(first));
  // A kit Dialog opened from the body registers after the sheet (BackHandler
  // runs listeners newest-first) and closes itself on back.
  const picker = jest.fn(() => true);
  BackHandler.addEventListener('hardwareBackPress', picker);

  // A tag toggled in the picker re-renders the body, and the callers' onDismiss
  // is a fresh closure every render.
  const latest = jest.fn();
  rerender(tree(latest));

  expect(backListeners).toHaveLength(2);
  expect(backListeners.at(-1)).toBe(picker);
  // Once the picker has closed, back reaches the sheet — and its CURRENT
  // onDismiss, the one that knows the draft as it is now.
  expect(backListeners[0]()).toBe(true);
  expect(latest).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
});

it('lets back fall through while another route covers it or a relock hides it', () => {
  const onDismiss = jest.fn();
  const tree = (covered: boolean) => (
    <AppCover covered={covered}>
      <SheetHost>
        <Sheet
          title="Advanced search"
          closeLabel="Close advanced search"
          onClose={jest.fn()}
          onDismiss={onDismiss}
          reveal={reveal}
        >
          <Text>body</Text>
        </Sheet>
      </SheetHost>
    </AppCover>
  );
  const { rerender } = render(tree(false));

  // Upgrade pushed Subscription over the links section; the sheet stays mounted.
  mockFocused = false;
  rerender(tree(false));
  expect(backListeners[0]()).toBe(false);

  mockFocused = true;
  rerender(tree(true));
  expect(backListeners[0]()).toBe(false);
  expect(onDismiss).not.toHaveBeenCalled();

  rerender(tree(false));
  expect(backListeners[0]()).toBe(true);
  expect(onDismiss).toHaveBeenCalledTimes(1);
  // One registration throughout — the gates never re-order it.
  expect(BackHandler.addEventListener).toHaveBeenCalledTimes(1);
});

// The other half of the ordering: the topbar's search handler re-registers on
// regaining focus, which put it ahead of an open sheet's, so the covered
// content reads this and stands down instead.
it('tells the covered content whether a sheet is open', () => {
  function Probe() {
    return <Text testID="probe">{String(useSheetOpen())}</Text>;
  }
  const tree = (isOpen: boolean) => (
    <SheetHost>
      <SheetCovered>
        <Probe />
      </SheetCovered>
      {isOpen && (
        <Sheet
          title="Advanced search"
          closeLabel="Close advanced search"
          onClose={jest.fn()}
          onDismiss={jest.fn()}
          reveal={reveal}
        >
          <Text>body</Text>
        </Sheet>
      )}
    </SheetHost>
  );
  const { rerender } = render(tree(false));
  const probe = () => screen.getByTestId('probe', { includeHiddenElements: true });
  expect(probe()).toHaveTextContent('false');

  rerender(tree(true));
  expect(probe()).toHaveTextContent('true');

  rerender(tree(false));
  expect(probe()).toHaveTextContent('false');
});

it('renders its body', () => {
  renderSheet(true);

  expect(screen.getByText('body')).toBeTruthy();
});

it('hides the covered subtree from a screen reader while open, and only then', () => {
  const { rerenderOpen } = renderSheet(false);
  // The nearest ancestor of the covered content that says anything about it.
  const hidden = () => {
    let node = screen.getByTestId('covered', { includeHiddenElements: true }).parent;
    while (node && node.props.importantForAccessibility === undefined) node = node.parent;
    return node?.props.importantForAccessibility;
  };

  expect(hidden()).toBe('auto');

  rerenderOpen(true);
  expect(hidden()).toBe('no-hide-descendants');

  rerenderOpen(false);
  expect(hidden()).toBe('auto');
  expect(backListeners).toHaveLength(0);
});

it('throws outside a SheetHost rather than covering nothing', () => {
  jest.spyOn(console, 'error').mockImplementation(jest.fn());

  expect(() =>
    render(
      <Sheet
        title="Orphan"
        closeLabel="Close"
        onClose={jest.fn()}
        onDismiss={jest.fn()}
        reveal={reveal}
      >
        <Text>body</Text>
      </Sheet>,
    ),
  ).toThrow('Sheet must be rendered inside a SheetHost');
});

import * as React from 'react';
import { View } from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { AppCover } from '../../contexts/app-cover';
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from './alert-dialog';
import { Dialog, DialogContent, DialogTitle } from './dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Peek } from './peek';
import { Text } from './text';

// The kit's portaled surfaces against a relock (docs/locks.md, _overlays
// over a relock_). They portal OUT of AppLockGate's `display: none` subtree, so
// on a device an overlay left open when the auto-relock lands stays painted and
// tappable over the lock pane — measured on both platforms, and invisible to
// every other check: the gate's own spec passes, the pane renders, and a leaked
// menu reads as a correct lock screen until someone looks at the phone.
//
// Each case pins both halves: covered → gone, uncovered → back, with the
// caller's open state untouched between the two. The "back" half is also the
// positive control that makes the "gone" half mean anything.
//
// SURFACES is the whole set, not a sample: a new portaled kit component (a
// Popover, a Select) reads `useAppCovered()` the way these do and adds
// its row here. Lint already routes every overlay through the kit; this table
// is what checks the kit then honours the flag.

beforeEach(() => {
  // The dropdown measures its trigger before it will place the content.
  jest
    .spyOn(View.prototype, 'measure')
    .mockImplementation((callback) => callback(0, 0, 32, 32, 300, 400));
});

afterEach(() => {
  jest.restoreAllMocks();
});

type Surface = { name: string; content: string; open?: () => void; tree: React.ReactNode };

const SURFACES: Surface[] = [
  {
    name: 'Dialog',
    content: 'Edit tags',
    tree: (
      <Dialog open onOpenChange={() => undefined}>
        <DialogContent>
          <DialogTitle>Edit tags</DialogTitle>
        </DialogContent>
      </Dialog>
    ),
  },
  {
    name: 'AlertDialog',
    content: 'Delete permanently?',
    tree: (
      <AlertDialog open onOpenChange={() => undefined}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete permanently?</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>
    ),
  },
  {
    // Uncontrolled on native (no `open` prop), so it is opened by its trigger.
    name: 'DropdownMenu',
    content: 'Rename',
    open: () => fireEvent.press(screen.getByLabelText('List actions')),
    tree: (
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="List actions">
          <Text>⋯</Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>
            <Text>Rename</Text>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  },
  {
    // Shown only while a row is held, so a relock landing mid-hold is a narrow
    // window — but the bubble names a list, which is what a lock hides.
    name: 'Peek',
    content: 'Reading list',
    tree: <Peek anchor={{ x: 0, y: 200, width: 100, height: 36 }} title="Reading list" />,
  },
];

const withCover = (covered: boolean, tree: React.ReactNode) => (
  <>
    <AppCover covered={covered}>{tree}</AppCover>
    <PortalHost />
  </>
);

// Hidden elements included: the Peek is hidden from screen readers by design, and
// "gone" has to mean gone from the tree, not merely from the accessibility tree.
const all = { includeHiddenElements: true };

test.each(SURFACES)(
  "$name's content leaves while a relock covers the app, and returns on unlock",
  ({ content, open, tree }) => {
    const view = render(withCover(false, tree));
    open?.();
    expect(screen.getByText(content, all)).toBeTruthy();

    view.rerender(withCover(true, tree));
    expect(screen.queryByText(content, all)).toBeNull();

    view.rerender(withCover(false, tree));
    expect(screen.getByText(content, all)).toBeTruthy();
  },
);

import * as React from 'react';
import { PortalHost } from '@rn-primitives/portal';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { Dialog, DialogContent, DialogTitle } from './dialog';

// DialogCloseButton's two branches, and what neither the runner nor the device
// would report if they swapped (dialog.tsx's note carries the derivation).
//
// The DEFAULT branch hands the kit's Button to `DialogPrimitive.Close` through
// `asChild`, which is only correct because that primitive's NATIVE build
// destructures the prop — the same build's Title does not, and there the
// identical spelling silently renders a bare RN Text around ours. Drop it here
// and the primitive wraps the Button in a SECOND Pressable: on a device the
// inner one wins the responder and the X goes dead, while "pressing Close
// closes it" keeps passing under RNTL, whose `fireEvent` walks UP the tree for a
// handler. So the shape is what gets pinned — one control, never a control
// inside a control, which is also what stops a screen reader announcing a button
// within a button.
//
// The `onClose` branch must take no Slot at all: it exists to BYPASS the
// primitive so a guarded editor's corner X reaches the unguarded close, instead
// of arriving at `onOpenChange` indistinguishable from the strays it is meant to
// be told apart from (docs/editors.md, invariant 3 — the X is a deliberate
// door). Route it through the Slot as well and the press also closes the Root,
// which is the dead-X bug wearing the opposite costume.
function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onClose={onClose}>
          <DialogTitle>Edit tags</DialogTitle>
        </DialogContent>
      </Dialog>
      <PortalHost />
    </>
  );
}

describe('DialogCloseButton', () => {
  it('is one control, not the primitive wrapped around the kit Button', () => {
    render(<Harness />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('closes through the primitive when given no onClose', () => {
    render(<Harness />);
    expect(screen.getByText('Edit tags')).toBeTruthy();
    fireEvent.press(screen.getByText('Close'));
    expect(screen.queryByText('Edit tags')).toBeNull();
  });

  it('calls onClose and leaves the Root alone when given one', () => {
    const onClose = jest.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.press(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Edit tags')).toBeTruthy();
  });
});

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@stxapps/web-ui/components/ui/dropdown-menu';

import { DestroyConfirm, RenameField, useDestroyRequest, useRowMenuFocus } from './table-kit';

// Pins the delete flow the Lists and Tags tables share. Each case is a failure
// with no other symptom: a refusal a screen away from the row that asked (the bug
// this flow replaced), a dialog that opens with focus stranded outside it, a late
// refusal that appears without being announced, or a stale check that raises the
// wrong row's dialog. The sections only pass their own mutations through, so the
// flow is spec'd here once rather than per table.

const item = (id: string) => ({ id });

function Harness({
  blocker,
  onDestroy,
}: {
  blocker: (entry: { id: string }) => Promise<string | null>;
  onDestroy: (id: string) => Promise<void>;
}) {
  const { destroyRequest, requestDestroy, closeDestroy } = useDestroyRequest(blocker);
  return (
    <>
      <button type="button" onClick={() => requestDestroy(item('a'))}>
        Request a
      </button>
      <button type="button" onClick={() => requestDestroy(item('b'))}>
        Request b
      </button>
      {destroyRequest && (
        <DestroyConfirm
          noun="list"
          blocker={destroyRequest.blocker}
          description={`Confirm ${destroyRequest.id}`}
          onDestroy={() => onDestroy(destroyRequest.id)}
          onClose={closeDestroy}
        />
      )}
    </>
  );
}

test('a blocked delete opens as the refusal, focused, with nothing that can fire destroy', async () => {
  const onDestroy = jest.fn(() => Promise.resolve());
  render(
    <Harness
      blocker={() => Promise.resolve('“a” still has 2 links. Move or delete them first.')}
      onDestroy={onDestroy}
    />,
  );

  fireEvent.click(screen.getByText('Request a'));
  const dialog = await screen.findByRole('alertdialog');

  expect(dialog.textContent).toContain('Can’t delete this list');
  expect(dialog.textContent).toContain('“a” still has 2 links. Move or delete them first.');
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  // Radix focuses the alert dialog's Cancel on open and has no fallback — this is
  // what the dismiss being a Cancel rather than an Action buys.
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK' }));

  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(onDestroy).not.toHaveBeenCalled();
});

test('a clear delete confirms, and closes once destroy resolves', async () => {
  const onDestroy = jest.fn(() => Promise.resolve());
  render(<Harness blocker={() => Promise.resolve(null)} onDestroy={onDestroy} />);

  fireEvent.click(screen.getByText('Request a'));
  expect((await screen.findByRole('alertdialog')).textContent).toContain('Confirm a');

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  });

  expect(onDestroy).toHaveBeenCalledWith('a');
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test('a refusal from destroy itself announces, and keeps the dialog up', async () => {
  // The check passed, then another device filed a link into the list before the
  // click — destroy re-checks and throws. The line mounts as the result of the
  // click, so it must carry role="alert" (docs/accessibility.md).
  const onDestroy = jest.fn(() =>
    Promise.reject(new Error('“a” still has 1 link. Move or delete it first.')),
  );
  render(<Harness blocker={() => Promise.resolve(null)} onDestroy={onDestroy} />);

  fireEvent.click(screen.getByText('Request a'));
  await screen.findByRole('alertdialog');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  });

  expect(screen.getByRole('alert').textContent).toContain(
    '“a” still has 1 link. Move or delete it first.',
  );
  expect(screen.queryByRole('alertdialog')).not.toBeNull();
});

test('a check overtaken by a newer request never raises its dialog', async () => {
  // a's check is slow and b's is fast: b's dialog opens first, and a's settling
  // late must not swap it out from under the reader.
  let settleA: (reason: string | null) => void = () => undefined;
  const blocker = ({ id }: { id: string }) =>
    id === 'a'
      ? new Promise<string | null>((resolve) => {
          settleA = resolve;
        })
      : Promise.resolve(null);
  render(<Harness blocker={blocker} onDestroy={() => Promise.resolve()} />);

  fireEvent.click(screen.getByText('Request a'));
  fireEvent.click(screen.getByText('Request b'));
  expect((await screen.findByRole('alertdialog')).textContent).toContain('Confirm b');

  await act(async () => {
    settleA('“a” still has 2 links. Move or delete them first.');
  });

  expect(screen.getByRole('alertdialog').textContent).toContain('Confirm b');
});

// The commit fires a promise the field only reacts to when it settles; this
// flushes that microtask and the re-render it causes.
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

// RenameField's revert. Same silent failure in all three: the field is
// uncontrolled and the call site keys it on the STORED name, so a commit that
// doesn't land leaves the row displaying a name nothing holds — no error on the
// row, no re-render, nothing until the section is re-entered. The expo twin
// asserts the same three facts through a remount, having no `value` to read.

const renameField = () => screen.getByLabelText<HTMLInputElement>('List name');

const commit = (text: string) => {
  const input = renameField();
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
};

// The positive control for the two reverts below: without it, "the field shows
// Reading" would be satisfied just as well by a field that reverts EVERY commit,
// which would throw away a rename that did land.
test('a rename that lands leaves the typed name in the field', async () => {
  const onRename = jest.fn(() => Promise.resolve());
  render(<RenameField name="Reading" label="List name" onRename={onRename} />);

  commit('Reading later');
  await flush();

  expect(onRename).toHaveBeenCalledWith('Reading later');
  expect(renameField().value).toBe('Reading later');
});

test('a rename the store rejects puts the stored name back', async () => {
  const onRename = jest.fn(() => Promise.reject(new Error('Storage is full.')));
  render(<RenameField name="Reading" label="List name" onRename={onRename} />);

  commit('Reading later');
  await flush();

  expect(onRename).toHaveBeenCalledWith('Reading later');
  expect(renameField().value).toBe('Reading');
});

test('a blank name is not a rename, and never reaches the mutation', async () => {
  // The mutations treat a blank name as "no rename" rather than an error, so
  // nothing throws and nothing else would take the empty field back.
  const onRename = jest.fn(() => Promise.resolve());
  render(<RenameField name="Reading" label="List name" onRename={onRename} />);

  commit('   ');
  await flush();

  expect(onRename).not.toHaveBeenCalled();
  expect(renameField().value).toBe('Reading');
});

// jsdom implements neither of the two APIs Radix's popper reaches for at mount,
// and neither is a subject here — they are seams, exactly as web-ui's shared
// jsdom stubs are for the specs in that package (this app has no route to those:
// `@stxapps/web-ui` exports components, not its testing folder).
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe = noop;
    unobserve = noop;
    disconnect = noop;
  };
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= noop;
  Element.prototype.releasePointerCapture ??= noop;
});

function noop(): undefined {
  return undefined;
}

const flushTimers = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

// The row kebab both tables render, reduced to the two items whose close-focus
// differs: Rename hands focus to the inline field, everything else hands it back
// to the trigger.
function RowMenuHarness({ onFocusName }: { onFocusName: () => void }) {
  const { triggerRef, onRenameSelect, onCloseAutoFocus } = useRowMenuFocus(onFocusName);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger ref={triggerRef}>List actions</DropdownMenuTrigger>
      <DropdownMenuContent onCloseAutoFocus={onCloseAutoFocus}>
        <DropdownMenuItem onSelect={onRenameSelect}>Rename</DropdownMenuItem>
        <DropdownMenuItem onSelect={noop}>Move up</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const openRowMenu = async (onFocusName: () => void = noop) => {
  render(<RowMenuHarness onFocusName={onFocusName} />);
  const trigger = screen.getByRole('button', { name: 'List actions' });
  const focus = jest.spyOn(trigger, 'focus');
  // Opened from the keyboard: jsdom has no PointerEvent, so Radix's
  // pointer-down path never sees a button 0 to toggle on.
  fireEvent.keyDown(trigger, { key: 'Enter' });
  await screen.findByRole('menu');
  focus.mockClear();
  return focus;
};

// Radix restores focus to the trigger on close with a bare `.focus()`, and a
// focus that scrolls is a focus that scrolls the page AWAY from the notice the
// op just posted at the top of the pane — the restore runs last, so it wins.
// jsdom has no layout to scroll, so the argument IS the assertion here; the
// movement it prevents was driven in a browser (see the hook, and
// docs/editors.md).
test('closing the row menu hands focus back to the trigger without scrolling', async () => {
  const focus = await openRowMenu();

  fireEvent.click(screen.getByRole('menuitem', { name: 'Move up' }));

  // Radix dispatches the close-focus event from a timeout after the content
  // unmounts — the same timeout its own trigger restore would have run in.
  await flushTimers();
  expect(focus).toHaveBeenCalledTimes(1);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});

test('Rename keeps the field, not the trigger — the menu closing never takes it back', async () => {
  const onFocusName = jest.fn();
  const focus = await openRowMenu(onFocusName);

  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

  await flushTimers();
  expect(onFocusName).toHaveBeenCalledTimes(1);
  expect(focus).not.toHaveBeenCalled();
});

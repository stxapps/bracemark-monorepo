import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { DestroyConfirm, useDestroyRequest } from './table-kit';

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

import { act, fireEvent, render, screen } from '@testing-library/react';

import { SESSION_COPY } from '@stxapps/react';

import { SignOutProvider, useSignOutFlow } from './sign-out-provider';

// Specs for the hoisted sign-out flow — bracemark-web's links menu and lock pane, and the
// browser extension's options page. What it guards is the stretch between the click and
// the wipe, and both halves fail without a sound:
//
//  - a sign-out erases this browser's pending queue, and a queued change exists nowhere
//    else. Skip the question and the click simply works — the loss shows up later, as an
//    edit that is not there after signing back in, with nothing pointing back here;
//  - the revocation request goes out BEFORE the wipe, and the app behind a closed menu
//    was fully usable for as long as the network took. Whatever was saved then was erased.
//
// The mutation itself is `useSignOut` (web-react, spec'd there) and is mocked: this file
// is about when it is called, what covers the page meanwhile, and what a failure says.
// bracemark-expo's contexts/sign-out-provider.spec.tsx is the sibling, case for case.

const COPY = SESSION_COPY.signOut;

let mockPendingOps = 0;
let mockIsPending = false;
let mockIsError = false;
const mockMutate = jest.fn();
const mockReset = jest.fn();
const mockCountPendingOps = jest.fn((_username: string) => Promise.resolve(mockPendingOps));

jest.mock('@stxapps/web-react', () => ({
  useAuth: () => ({ username: 'alice' }),
  useSignOut: () => ({
    mutate: mockMutate,
    reset: mockReset,
    isPending: mockIsPending,
    isError: mockIsError,
  }),
  countPendingOps: (username: string) => mockCountPendingOps(username),
}));

function Trigger() {
  const { requestSignOut } = useSignOutFlow();
  return (
    <button type="button" onClick={requestSignOut}>
      Menu item
    </button>
  );
}

const tree = () => (
  <SignOutProvider>
    <Trigger />
  </SignOutProvider>
);

// Click, and let the count the click reads resolve.
async function click() {
  fireEvent.click(screen.getByText('Menu item'));
  await act(async () => undefined);
}

beforeEach(() => {
  mockPendingOps = 0;
  mockIsPending = false;
  mockIsError = false;
  mockMutate.mockClear();
  mockReset.mockClear();
  mockCountPendingOps.mockClear();
});

describe('with nothing unsynced', () => {
  // The library is on the server, so the erase costs a sign-in. A question here is a
  // question on every sign-out, which is how the one that matters gets clicked through.
  it('signs out at the click, without asking', async () => {
    render(tree());

    await click();

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(COPY.title)).toBeNull();
  });

  // The cover: named, and with no way out. Nothing behind it may be reachable while the
  // request is out, so there is no button to click and Escape has nothing to do.
  it('covers the page with the wait, and offers no way out of it', async () => {
    render(tree());

    await click();

    expect(screen.getByRole('alertdialog', { name: COPY.progress })).toBeTruthy();
    expect(screen.queryByText(COPY.cancel)).toBeNull();
    expect(screen.queryByText(COPY.confirm)).toBeNull();

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });

    expect(screen.getByRole('alertdialog', { name: COPY.progress })).toBeTruthy();
  });
});

describe('with changes that have not synced', () => {
  beforeEach(() => {
    mockPendingOps = 3;
  });

  it('asks first, with the count, and signs nothing out yet', async () => {
    render(tree());

    await click();

    expect(screen.getByRole('alertdialog', { name: COPY.title })).toBeTruthy();
    expect(screen.getByText(COPY.description(3))).toBeTruthy();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('signs out on the confirm, and stays up until it lands', async () => {
    render(tree());
    await click();

    fireEvent.click(screen.getByTestId('sign-out-confirm'));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('cancels back to the app with nothing signed out', async () => {
    render(tree());
    await click();

    fireEvent.click(screen.getByText(COPY.cancel));

    expect(mockMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  // The count is read at the click, so a cancelled flow has to be able to start again —
  // and read again, since the sync the dialog recommended may have emptied the queue.
  it('reads the count afresh the next time', async () => {
    render(tree());
    await click();
    fireEvent.click(screen.getByText(COPY.cancel));
    mockPendingOps = 0;

    await click();

    expect(mockCountPendingOps).toHaveBeenCalledTimes(2);
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  // Once confirmed there is no cancelling half a sign-out. The pending state rides in the
  // LABEL (docs/accessibility.md): a button that only dims says nothing to a screen reader.
  it('says so in the button while it runs, and can no longer be cancelled', async () => {
    const view = render(tree());
    await click();
    mockIsPending = true;
    view.rerender(tree());

    expect(screen.getByTestId('sign-out-confirm')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('sign-out-confirm').textContent).toBe(COPY.progress);
    expect(screen.getByText(COPY.cancel)).toHaveProperty('disabled', true);

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });

    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});

// The lock pane's link is a plain button, not a menu item that closes under the pointer:
// a double click lands twice. The count is read asynchronously, so both would get in
// before the flow's state existed.
it('starts one sign-out for a double click', async () => {
  render(tree());

  fireEvent.click(screen.getByText('Menu item'));
  fireEvent.click(screen.getByText('Menu item'));
  await act(async () => undefined);

  expect(mockMutate).toHaveBeenCalledTimes(1);
});

// The mutation rejects only when the session record could not be deleted, and it used to
// reject into nothing — a click that did nothing at all.
describe('a sign-out that failed', () => {
  it('says so, and offers the retry and the way back', async () => {
    const view = render(tree());
    await click();
    mockIsError = true;
    view.rerender(tree());

    expect(screen.getByRole('alert').textContent).toBe(COPY.failed);
    expect(screen.getByText(COPY.retry)).toBeTruthy();

    fireEvent.click(screen.getByText(COPY.cancel));

    expect(mockReset).toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

// A count that cannot be read must not trap anyone signed in.
it('goes ahead when the count cannot be read', async () => {
  mockCountPendingOps.mockImplementationOnce(() => Promise.reject(new Error('idb')));
  render(tree());

  await click();

  expect(mockMutate).toHaveBeenCalledTimes(1);
});

it('refuses reads outside its provider', () => {
  function OutsideProbe() {
    useSignOutFlow();
    return null;
  }
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  expect(() => render(<OutsideProbe />)).toThrow(/must be used within <SignOutProvider>/);
  errorSpy.mockRestore();
});

// Specs for the hoisted sign-out flow. What it guards is the stretch between the press and
// the wipe, and both halves fail without a sound:
//
//  - a sign-out erases this device's pending queue, and a queued change exists nowhere
//    else. Skip the sync, or the question about what it could not save, and the press
//    simply works — the loss shows up later, as an edit that is not there after signing
//    back in, with nothing pointing back here;
//  - the revocation request goes out BEFORE the wipe, and the app behind a closed menu
//    was fully usable for as long as the network took. Whatever was saved then was erased.
//
// The mutation itself is `useSignOut` (expo-react, spec'd there) and is mocked, and so is
// the cycle (`useSync().syncAndWait`): this file is about when each is called, what
// covers the app meanwhile, and what a failure says. The bound on the sync's wait is
// sync-before-sign-out.ts's, spec'd in @stxapps/react.

import * as React from 'react';
import { Pressable } from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { SESSION_COPY } from '@stxapps/react';

import { Text } from '../components/ui/text';
import { SignOutProvider, useSignOutFlow } from './sign-out-provider';

const COPY = SESSION_COPY.signOut;

let mockGeneration = 'original';
let mockPendingOps = 0;
let mockIsPending = false;
let mockIsSuccess = false;
let mockIsError = false;
const mockMutate = jest.fn();
const mockReset = jest.fn();
const mockCountPendingOps = jest.fn((_username: string) => Promise.resolve(mockPendingOps));
// What the cycle does to the queue is each case's to say. The default pushes nothing,
// which is a sync that could not save the changes: offline, expired, over the limit.
let mockSync: () => Promise<void> = () => Promise.resolve();
const mockSyncAndWait = jest.fn(() => mockSync());

jest.mock('@stxapps/expo-react', () => ({
  useAuth: () => ({ username: 'alice' }),
  getSession: () => ({ generation: mockGeneration }),
  useSignOut: () => ({
    mutate: mockMutate,
    reset: mockReset,
    isPending: mockIsPending,
    isError: mockIsError,
    isSuccess: mockIsSuccess,
  }),
  countPendingOps: (username: string) => mockCountPendingOps(username),
  useSync: () => ({ syncAndWait: mockSyncAndWait }),
}));

const mockClearMemoryCache = jest.fn(() => Promise.resolve(true));
jest.mock('expo-image', () => ({
  Image: { clearMemoryCache: () => mockClearMemoryCache() },
}));

function Trigger() {
  const { requestSignOut } = useSignOutFlow();
  return (
    <Pressable role="button" onPress={requestSignOut}>
      <Text>Menu item</Text>
    </Pressable>
  );
}

const tree = () => (
  <>
    <SignOutProvider>
      <Trigger />
    </SignOutProvider>
    <PortalHost />
  </>
);

// Press, and let the flow run as far as it can: the count, and with something pending
// the sync and the count after it.
async function press() {
  fireEvent.press(screen.getByText('Menu item'));
  await act(async () => undefined);
}

// A cycle the case settles by hand, to stand inside the wait.
function heldSync() {
  let release!: () => void;
  mockSync = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  return { release: () => act(async () => release()) };
}

beforeEach(() => {
  mockGeneration = 'original';
  mockPendingOps = 0;
  mockIsPending = false;
  mockIsSuccess = false;
  mockIsError = false;
  mockMutate.mockClear();
  mockReset.mockClear();
  mockCountPendingOps.mockReset();
  mockCountPendingOps.mockImplementation(() => Promise.resolve(mockPendingOps));
  mockSync = () => Promise.resolve();
  mockSyncAndWait.mockClear();
  mockClearMemoryCache.mockClear();
});

describe('with nothing unsynced', () => {
  // The library is on the server, so the erase costs a sign-in. A question here is a
  // question on every sign-out, which is how the one that matters gets pressed through.
  it('signs out at the press, without asking', async () => {
    render(tree());

    await press();

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(COPY.title)).toBeNull();
    expect(mockSyncAndWait).not.toHaveBeenCalled();
  });

  // The cover: named, and with no way out. Nothing behind it may be reachable while the
  // request is out, so there is no button to press and nothing for a dismissal to do.
  it('covers the app with the wait, and offers no way out of it', async () => {
    render(tree());

    await press();

    expect(screen.getByText(COPY.progress)).toBeTruthy();
    expect(screen.queryByText(COPY.cancel)).toBeNull();
    expect(screen.queryByText(COPY.confirm)).toBeNull();
  });
});

// "Cancel and sync first" was the old answer to a pending queue. The app can sync by
// itself, and the app-lock pane's "forgot the password" caller cannot: behind the lock
// there is no sync to press, and nothing runs a cycle after a relock on its own.
describe('with changes that have not synced yet', () => {
  beforeEach(() => {
    mockPendingOps = 3;
  });

  it('syncs before it asks anything, and says that is the wait', async () => {
    const sync = heldSync();
    render(tree());

    await press();

    expect(mockSyncAndWait).toHaveBeenCalledTimes(1);
    expect(screen.getByText(COPY.syncing)).toBeTruthy();
    expect(screen.getByText(COPY.syncingDescription(3))).toBeTruthy();
    expect(screen.queryByTestId('sign-out-confirm')).toBeNull();
    expect(mockMutate).not.toHaveBeenCalled();

    // Not left out: the bound's timer would outlive the spec.
    await sync.release();
  });

  // The queue emptied, so this is the commonest path again: no question.
  it('signs out without asking once the sync has pushed them', async () => {
    mockSync = () => {
      mockPendingOps = 0;
      return Promise.resolve();
    };
    render(tree());

    await press();

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(COPY.title)).toBeNull();
    expect(screen.getByText(COPY.progress)).toBeTruthy();
  });

  // The queue is the answer, not the cycle: one that pushed some and failed, or
  // completed with part of it refused, leaves exactly what is about to be lost.
  it('asks about what the sync left behind, by its own count', async () => {
    mockSync = () => {
      mockPendingOps = 1;
      return Promise.reject(new Error('offline'));
    };
    render(tree());

    await press();

    expect(screen.getByText(COPY.title)).toBeTruthy();
    expect(screen.getByText(COPY.description(1))).toBeTruthy();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  // Nothing is erased while the sync is out, so unlike the sign-out's own wait this
  // one has a way back — and taking it has to END that sign-out. Its continuation is
  // still waiting on the cycle, and a queue the cycle then empties must not sign out
  // a user who has gone back to the app.
  it('can be cancelled mid-sync, and stays cancelled when the sync lands', async () => {
    const sync = heldSync();
    render(tree());
    await press();

    fireEvent.press(screen.getByText(COPY.cancel));

    expect(screen.queryByTestId('sign-out-dialog')).toBeNull();

    mockPendingOps = 0;
    await sync.release();

    expect(mockMutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sign-out-dialog')).toBeNull();
  });

  it('starts afresh after a cancel mid-sync', async () => {
    const sync = heldSync();
    render(tree());
    await press();
    fireEvent.press(screen.getByText(COPY.cancel));
    await sync.release();
    mockSync = () => {
      mockPendingOps = 0;
      return Promise.resolve();
    };

    await press();

    expect(mockSyncAndWait).toHaveBeenCalledTimes(2);
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });
});

describe('with changes a sync could not save', () => {
  beforeEach(() => {
    mockPendingOps = 3;
  });

  it('asks, with the count, and signs nothing out yet', async () => {
    render(tree());

    await press();

    expect(mockSyncAndWait).toHaveBeenCalledTimes(1);
    expect(screen.getByText(COPY.title)).toBeTruthy();
    expect(screen.getByText(COPY.description(3))).toBeTruthy();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('signs out on the confirm', async () => {
    render(tree());
    await press();

    fireEvent.press(screen.getByTestId('sign-out-confirm'));

    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it('cancels back to the app with nothing signed out', async () => {
    render(tree());
    await press();

    fireEvent.press(screen.getByText(COPY.cancel));

    expect(mockMutate).not.toHaveBeenCalled();
    expect(screen.queryByText(COPY.title)).toBeNull();
  });

  // "Try again later" is the dialog's advice, so a cancelled flow has to be able to
  // start again — and read again, since the queue may have emptied meanwhile.
  it('reads the count afresh the next time', async () => {
    render(tree());
    await press();
    const read = mockCountPendingOps.mock.calls.length;
    fireEvent.press(screen.getByText(COPY.cancel));
    mockPendingOps = 0;

    await press();

    expect(mockCountPendingOps.mock.calls.length).toBeGreaterThan(read);
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  // Once confirmed there is no cancelling half a sign-out. The pending state rides in the
  // LABEL (docs/accessibility.md): a button that only dims says nothing to a screen reader.
  it('says so in the button while it runs, and can no longer be cancelled', async () => {
    const view = render(tree());
    await press();
    mockIsPending = true;
    view.rerender(tree());

    expect(screen.getByTestId('sign-out-confirm')).toBeDisabled();
    expect(screen.getByText(COPY.progress)).toBeTruthy();
    expect(screen.getByText(COPY.cancel)).toBeDisabled();
  });

  it('copes with a count of one', () => {
    expect(COPY.description(1)).toContain('1 change that hasn’t synced and exists nowhere else');
    expect(COPY.description(1)).toContain('We couldn’t sync it just now. To keep it,');
    expect(COPY.description(2)).toContain('2 changes that haven’t synced and exist nowhere else');
    expect(COPY.syncingDescription(1)).toContain('1 change that hasn’t synced, so');
    expect(COPY.syncingDescription(1)).toContain('erase it.');
    expect(COPY.syncingDescription(2)).toContain('2 changes that haven’t synced, so');
  });
});

// The lock pane's link is plain text, not a menu item that closes under the finger: a
// double tap lands twice. The count is read asynchronously, so both would get in before
// the flow's state existed.
it('starts one sign-out for a double press', async () => {
  render(tree());

  fireEvent.press(screen.getByText('Menu item'));
  fireEvent.press(screen.getByText('Menu item'));
  await act(async () => undefined);

  expect(mockMutate).toHaveBeenCalledTimes(1);
});

// The mutation rejects only when the session record could not be deleted, and it used to
// reject into nothing — a press that did nothing at all.
describe('a sign-out that failed', () => {
  it('says so, and offers the retry and the way back', async () => {
    const view = render(tree());
    await press();
    mockIsError = true;
    view.rerender(tree());

    expect(screen.getByTestId('sign-out-error')).toHaveTextContent(COPY.failed);
    expect(screen.getByText(COPY.retry)).toBeTruthy();

    fireEvent.press(screen.getByText(COPY.cancel));

    expect(mockReset).toHaveBeenCalled();
    expect(screen.queryByTestId('sign-out-error')).toBeNull();
  });
});

// An unreadable queue is unknown, not empty: sign-out stays available, but
// losing edits needs the user's explicit confirmation. It syncs all the same —
// whatever is queued, pushing it can only help.
it('asks before signing out when the count cannot be read', async () => {
  mockCountPendingOps.mockImplementation(() => Promise.reject(new Error('storage')));
  render(tree());
  await press();
  expect(mockSyncAndWait).toHaveBeenCalledTimes(1);
  expect(mockMutate).not.toHaveBeenCalled();
  expect(screen.getByText(COPY.descriptionUnknown)).toBeTruthy();
  fireEvent.press(screen.getByTestId('sign-out-confirm'));
  expect(mockMutate).toHaveBeenCalledTimes(1);
});

// The app layer's share of the teardown. An unmount cleanup also covers
// revocation and delete-account, which never call requestSignOut.
it('drops the decoded previews when the signed-in tree unmounts, however it ended', () => {
  const view = render(tree());
  expect(mockClearMemoryCache).not.toHaveBeenCalled();

  view.unmount();

  expect(mockClearMemoryCache).toHaveBeenCalledTimes(1);
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

// The count can outlive the auth-gated tree. mutate reads the CURRENT session,
// so an old request must never reach it after a replacement tree is mounted.
it('drops a pending count after unmount, even when a replacement is mounted', async () => {
  let resolve!: (count: number) => void;
  mockCountPendingOps.mockImplementationOnce(
    () =>
      new Promise<number>((done) => {
        resolve = done;
      }),
  );
  const old = render(tree());
  fireEvent.press(screen.getByText('Menu item'));
  old.unmount();
  render(tree());

  await act(async () => resolve(0));

  expect(mockMutate).not.toHaveBeenCalled();
  expect(screen.queryByTestId('sign-out-dialog')).toBeNull();
});

// endSession deliberately does nothing when another tab resumed the session.
// That is still a successful mutation, but this provider stays mounted.
it('releases the cover when sign-out settles without unmounting the tree', async () => {
  const view = render(tree());
  await press();
  mockIsSuccess = true;
  view.rerender(tree());

  expect(screen.queryByTestId('sign-out-dialog')).toBeNull();
  expect(mockReset).toHaveBeenCalled();
  mockIsSuccess = false;
  view.rerender(tree());
  await press();
  expect(mockMutate).toHaveBeenCalledTimes(2);
});

// The sync wait precedes the mutation's own generation capture. A resume here
// must not let an older click revoke the replacement session.
it('abandons a sync wait when the same account resumes, and allows a fresh request', async () => {
  mockPendingOps = 3;
  const sync = heldSync();
  render(tree());
  await press();
  mockGeneration = 'resumed';
  mockPendingOps = 0;
  await sync.release();

  expect(mockMutate).not.toHaveBeenCalled();
  expect(screen.queryByTestId('sign-out-dialog')).toBeNull();
  await press();
  expect(mockMutate).toHaveBeenCalledTimes(1);
});

it('does not confirm a warning belonging to a replaced session', async () => {
  mockPendingOps = 3;
  render(tree());
  await press();
  mockGeneration = 'resumed';

  fireEvent.press(screen.getByTestId('sign-out-confirm'));

  expect(mockMutate).not.toHaveBeenCalled();
  expect(screen.queryByTestId('sign-out-dialog')).toBeNull();
});

it('drops a sync completion after unmount', async () => {
  mockPendingOps = 3;
  const sync = heldSync();
  const view = render(tree());
  await press();
  view.unmount();
  mockPendingOps = 0;
  await sync.release();
  expect(mockMutate).not.toHaveBeenCalled();
});

it('keeps a cancelled sync separate from a second request already waiting', async () => {
  mockPendingOps = 3;
  const first = heldSync();
  render(tree());
  await press();
  fireEvent.press(screen.getByText(COPY.cancel));
  const second = heldSync();
  await press();
  mockPendingOps = 0;
  await first.release();
  expect(mockMutate).not.toHaveBeenCalled();
  expect(screen.getByText(COPY.syncing)).toBeTruthy();
  await second.release();
  expect(mockMutate).toHaveBeenCalledTimes(1);
});

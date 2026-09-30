import { act, render, screen } from '@testing-library/react';

import { type FakeBrowser, installFakeBrowser } from '../testing/fake-browser';
import {
  INITIAL_MIRRORED_SYNC_STATE,
  MIRRORED_SYNC_STATE_KEY,
  type MirroredSyncState,
  writeMirroredSyncState,
} from '../utils/mirrored-sync-state';
import { useMirroredSyncState } from './use-mirrored-sync-state';

// The React side of the background's sync mirror, and the ONLY subscriber to it —
// the popup provider tree feeds `ExternalSyncProvider` from this, so the pill, the
// detail view and the options page all read one subscription. Three things have to
// hold, and each is quiet when it doesn't:
//
//   - it has to KEEP UP. The popup is a live window onto a worker in another JS
//     context; a hook that only read once would show a stale pill for as long as the
//     popup stayed open, which is exactly as long as a user watches it.
//   - it has to ignore areas that aren't `local`. `storage.onChanged` is one event
//     for every area, and `sync` carries the browser profile's own settings.
//   - it has to unsubscribe. The popup unmounts on every close; a listener left
//     behind sets state on a dead tree. (The `active` flag guarding the initial
//     read is the same idea and is NOT asserted here — React 19 dropped the
//     unmounted-setState warning, so the difference is unobservable from a spec.)

const SYNCING: MirroredSyncState = {
  storeStatus: 'ready',
  bgSyncStatus: 'syncing',
  lastSyncAt: null,
  lastError: null,
  blockedCount: 0,
};

function Readout() {
  const state = useMirroredSyncState();
  return <span data-testid="state">{`${state.storeStatus}/${state.bgSyncStatus}`}</span>;
}

const shown = () => screen.getByTestId('state').textContent;

let fake: FakeBrowser;

beforeEach(() => {
  fake = installFakeBrowser();
});

describe('useMirroredSyncState', () => {
  it('starts from the initial state, before the read has landed', () => {
    render(<Readout />);

    expect(shown()).toBe(
      `${INITIAL_MIRRORED_SYNC_STATE.storeStatus}/${INITIAL_MIRRORED_SYNC_STATE.bgSyncStatus}`,
    );
  });

  it('picks up what the background had already written before this popup opened', async () => {
    await writeMirroredSyncState(SYNCING);

    render(<Readout />);
    await act(async () => undefined);

    expect(shown()).toBe('ready/syncing');
  });

  it('keeps up with the worker while the popup stays open', async () => {
    render(<Readout />);
    await act(async () => undefined);

    await act(async () => {
      await writeMirroredSyncState(SYNCING);
    });

    expect(shown()).toBe('ready/syncing');
  });

  it('ignores a change from another storage area', () => {
    render(<Readout />);

    act(() => {
      fake.storage.onChanged.emit(
        { [MIRRORED_SYNC_STATE_KEY]: { newValue: SYNCING } },
        // The browser profile's own synced settings — a different store entirely.
        'sync',
      );
    });

    expect(shown()).toBe('checking/idle');
  });

  it('ignores a change to some other key in the local area', () => {
    render(<Readout />);

    act(() => {
      fake.storage.onChanged.emit({ somethingElse: { newValue: SYNCING } }, 'local');
    });

    expect(shown()).toBe('checking/idle');
  });

  it('unsubscribes when the popup closes', () => {
    const { unmount } = render(<Readout />);
    expect(fake.storage.onChanged.addListener).toHaveBeenCalled();

    unmount();

    // EVERY listener added is removed — StrictMode (docs/testing.md) subscribes,
    // unsubscribes and subscribes again, so there is more than one to account for.
    const added = fake.storage.onChanged.addListener.mock.calls.map(([listener]) => listener);
    const removed = fake.storage.onChanged.removeListener.mock.calls.map(([listener]) => listener);
    expect(new Set(removed)).toEqual(new Set(added));
  });
});

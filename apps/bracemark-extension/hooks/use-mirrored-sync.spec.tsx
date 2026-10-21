import { act, render, screen } from '@testing-library/react';

import { type FakeBrowser, installFakeBrowser } from '../testing/fake-browser';
import {
  clearMirroredSyncProgress,
  INITIAL_MIRRORED_SYNC_STATE,
  MIRRORED_SYNC_STATE_KEY,
  type MirroredSyncState,
  writeMirroredSyncProgress,
  writeMirroredSyncState,
} from '../utils/mirrored-sync';
import { useMirroredSyncProgress, useMirroredSyncState } from './use-mirrored-sync';

// The React side of the background's sync mirror, and the ONLY subscriber to it —
// the popup provider tree feeds `ExternalSyncProvider` from these, so the pill, the
// detail view and the options page all read one subscription per record. Both hooks
// are one helper over a different area, so the status hook's cases below pin the
// helper and the progress hook's pin only what is its own. Four things have to
// hold, and each is quiet when it doesn't:
//
//   - it has to KEEP UP. The popup is a live window onto a worker in another JS
//     context; a hook that only read once would show a stale pill for as long as the
//     popup stayed open, which is exactly as long as a user watches it.
//   - it has to ignore areas that aren't `local`. `storage.onChanged` is one event
//     for every area, and `sync` carries the browser profile's own settings.
//   - the first read must not overwrite a newer write. A popup opened just as a
//     cycle starts reads the old status, and the worker's 'syncing' write can land
//     before that read resolves. Applied late, the old value would stay on the pill
//     until the next cycle's write.
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

  it('keeps a write that landed before its first read resolved', async () => {
    const IDLE: MirroredSyncState = { ...SYNCING, bgSyncStatus: 'idle', lastSyncAt: 1 };
    await writeMirroredSyncState(IDLE);

    // The fake's `get` snapshots the store when it is called, so the read issued on
    // mount already holds IDLE. It resolves only after this write announces itself.
    render(<Readout />);
    act(() => {
      void writeMirroredSyncState(SYNCING);
    });
    await act(async () => undefined);

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

function ProgressReadout() {
  const progress = useMirroredSyncProgress();
  return (
    <span data-testid="progress">
      {progress ? `${progress.step} ${progress.done}/${progress.total}` : 'none'}
    </span>
  );
}

const shownProgress = () => screen.getByTestId('progress').textContent;

// The progress record lives in `session`, not `local`, and the run REMOVES it when it
// ends (utils/sync-runner.ts). A hook listening on the status's area would never move,
// and one that ignored the removal would leave a bar drawn over a sync that is over.
describe('useMirroredSyncProgress', () => {
  it('follows the session area and drops the number when the run clears it', async () => {
    render(<ProgressReadout />);
    await act(async () => undefined);
    expect(shownProgress()).toBe('none');

    await act(async () => {
      await writeMirroredSyncProgress({ step: 'initial', done: 40, total: 200 });
    });
    expect(shownProgress()).toBe('initial 40/200');

    await act(async () => {
      await clearMirroredSyncProgress();
    });
    expect(shownProgress()).toBe('none');
  });
});

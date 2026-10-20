import { fireEvent, render, screen } from '@testing-library/react';

import type { BgSyncStatus, StoreStatus } from '@stxapps/shared';

import { SyncDetail, SyncPill } from './Sync';

// The popup's two sync surfaces. The PHASE arithmetic belongs to `@stxapps/shared`
// (`getSyncPhase`, `SYNC_PHASE_LABELS`, `syncBlockedDetail`) and is pinned there;
// what is only true here is what this surface does with the phase it is handed:
//
//   - THE PILL SAYS MORE THAN THE SHARED LABEL AT REST. "Up to date" is a claim;
//     "Synced 3 min ago" is the evidence for it, which is what someone opening a
//     sync pill wants. The never-synced case gets its own wording rather than a
//     stale-looking blank.
//   - THE DETAIL VIEW'S ONE ACTION IS PHASE-GATED. `requestSync` recovers both
//     error phases and a manual idle sync, so one button covers everything
//     actionable — and nothing is offered while a cycle is in flight, or when the
//     only fix is freeing space.
//   - A QUOTA REFUSAL IS NOT AN ERROR. The cycle completed. Offering "Retry" would
//     send the user round a loop that cannot help them.
//   - A RUN IN FLIGHT SAYS HOW FAR. The first sync used to be a bare "Setting up
//     this device…" for as long as it took; the pill now carries the percent and
//     the detail view the bar and the count, and only while the phase is the one
//     the numbers belong to.

const mockUseSync = jest.fn();
const mockUsePendingChangesCount = jest.fn(() => 0);

jest.mock('@stxapps/web-react', () => ({
  get useSync() {
    return mockUseSync;
  },
  get usePendingChangesCount() {
    return mockUsePendingChangesCount;
  },
}));

const requestSync = jest.fn();

function syncState(
  storeStatus: StoreStatus,
  bgSyncStatus: BgSyncStatus,
  extra: Record<string, unknown> = {},
) {
  return {
    storeStatus,
    bgSyncStatus,
    lastSyncAt: null,
    lastError: null,
    blockedCount: 0,
    requestSync,
    ...extra,
  };
}

const setSync = (...args: Parameters<typeof syncState>) =>
  mockUseSync.mockReturnValue(syncState(...args));

beforeEach(() => {
  jest.clearAllMocks();
  mockUsePendingChangesCount.mockReturnValue(0);
  setSync('ready', 'idle');
});

describe('SyncPill', () => {
  it.each([
    ['checking', 'checking' as StoreStatus, 'idle' as BgSyncStatus, 'Checking…'],
    [
      'first pull',
      'syncing-initial' as StoreStatus,
      'idle' as BgSyncStatus,
      'Setting up this device…',
    ],
    ['a cycle in flight', 'ready' as StoreStatus, 'syncing' as BgSyncStatus, 'Syncing…'],
    ['a failed first pull', 'error' as StoreStatus, 'idle' as BgSyncStatus, 'Sync failed'],
    ['a failed cycle', 'ready' as StoreStatus, 'error' as BgSyncStatus, 'Sync failed'],
    ['a quota refusal', 'ready' as StoreStatus, 'blocked-capacity' as BgSyncStatus, 'Storage full'],
    ['an expired session', 'ready' as StoreStatus, 'paused' as BgSyncStatus, 'Sync paused'],
  ])('reads "%s" as %s', (_name, store, bg, label) => {
    setSync(store, bg);

    render(<SyncPill onClick={jest.fn()} />);

    expect(screen.getByRole('button').textContent).toContain(label);
  });

  it('prints the evidence at rest, not the claim', () => {
    setSync('ready', 'idle', { lastSyncAt: Date.now() });

    render(<SyncPill onClick={jest.fn()} />);

    expect(screen.getByRole('button').textContent).toContain('Synced ');
  });

  it('says so plainly when this device has never synced', () => {
    setSync('ready', 'idle', { lastSyncAt: null });

    render(<SyncPill onClick={jest.fn()} />);

    expect(screen.getByRole('button').textContent).toContain('Not synced yet');
  });

  it('opens the detail view when pressed', () => {
    const onClick = jest.fn();
    render(<SyncPill onClick={onClick} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('SyncPill — a run in flight', () => {
  it('carries the first pull’s percent beside its label', () => {
    setSync('syncing-initial', 'syncing', { initialSyncProgress: { done: 1240, total: 3600 } });

    render(<SyncPill onClick={jest.fn()} />);

    expect(screen.getByRole('button').textContent).toContain('Setting up this device…');
    expect(screen.getByRole('button').textContent).toContain('34%');
  });

  it('carries a background cycle’s percent too', () => {
    setSync('ready', 'syncing', { syncProgress: { step: 'upload', done: 1, total: 4 } });

    render(<SyncPill onClick={jest.fn()} />);

    expect(screen.getByRole('button').textContent).toContain('25%');
  });

  // The provider may still hold the last leg's count; once the phase has moved
  // on it is history, and a percent beside "Synced just now" would contradict it.
  it('shows no percent at rest, whatever the provider still holds', () => {
    setSync('ready', 'idle', {
      lastSyncAt: Date.now(),
      syncProgress: { step: 'download', done: 2, total: 2 },
    });

    render(<SyncPill onClick={jest.fn()} />);

    expect(screen.getByRole('button').textContent).not.toContain('%');
  });
});

describe('SyncDetail — a run in flight', () => {
  it('draws the first pull as a progressbar carrying its count', () => {
    setSync('syncing-initial', 'syncing', { initialSyncProgress: { done: 1240, total: 3600 } });

    render(<SyncDetail onBack={jest.fn()} onResume={jest.fn()} />);

    const bar = screen.getByRole('progressbar', { name: 'Setting up this device' });
    expect(bar.getAttribute('aria-valuetext')).toBe('1,240 of 3,600 items');
    expect(bar.getAttribute('aria-valuenow')).toBe('1240');
    expect(screen.getByText('34%')).toBeTruthy();
    // A value repainting ten times a second must not be a live region.
    expect(document.querySelector('[aria-live]')).toBeNull();
  });

  // The listing has no denominator yet: something must still say what is
  // happening, and claim no value.
  it('draws the first pull’s listing as an indeterminate bar that says what it is', () => {
    setSync('syncing-initial', 'syncing');

    render(<SyncDetail onBack={jest.fn()} onResume={jest.fn()} />);

    const bar = screen.getByRole('progressbar', { name: 'Finding your links' });
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(screen.getByText('Finding your links…')).toBeTruthy();
  });

  it('tells the user the first pull does not need the popup open', () => {
    setSync('syncing-initial', 'syncing');

    render(<SyncDetail onBack={jest.fn()} onResume={jest.fn()} />);

    expect(screen.getByText(/You can close this popup/)).toBeTruthy();
  });

  it('names a background cycle’s leg in the status row', () => {
    setSync('ready', 'syncing', { syncProgress: { step: 'upload', done: 3, total: 10 } });

    render(<SyncDetail onBack={jest.fn()} onResume={jest.fn()} />);

    const status = [...document.querySelectorAll('dt')].find((dt) => dt.textContent === 'Status');
    expect(status?.nextElementSibling?.textContent).toBe('Sending your changes…');
    expect(
      screen
        .getByRole('progressbar', { name: 'Sending your changes' })
        .getAttribute('aria-valuetext'),
    ).toBe('3 of 10 changes');
  });

  it('draws nothing at rest, whatever the provider still holds', () => {
    setSync('ready', 'idle', { syncProgress: { step: 'download', done: 2, total: 2 } });

    render(<SyncDetail onBack={jest.fn()} onResume={jest.fn()} />);

    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

describe('SyncDetail', () => {
  const rows = () =>
    Object.fromEntries(
      [...document.querySelectorAll('dt')].map((dt) => [
        dt.textContent,
        dt.nextElementSibling?.textContent,
      ]),
    );

  it('reports the queued local edits from the store, not from the mirror', () => {
    // The mirror is the worker's view of the last cycle; the pending count is a
    // live read of what is waiting to go out.
    mockUsePendingChangesCount.mockReturnValue(4);

    render(<SyncDetail onBack={jest.fn()} onResume={jest.fn()} />);

    expect(rows()['Pending changes']).toBe('4');
  });

  it('says "Never" rather than leaving the last-sync row blank', () => {
    render(<SyncDetail onBack={jest.fn()} onResume={jest.fn()} />);

    expect(rows()['Last sync']).toBe('Never');
  });

  it('omits the last-error row when there is nothing to report', () => {
    render(<SyncDetail onBack={jest.fn()} onResume={jest.fn()} />);

    expect(rows()['Last error']).toBeUndefined();
  });

  it('shows the failed cycle’s own message, not a generic one', () => {
    setSync('ready', 'error', { lastError: 'Failed to fetch' });

    render(<SyncDetail onBack={jest.fn()} onResume={jest.fn()} />);

    expect(rows()['Last error']).toBe('Failed to fetch');
  });

  it('offers a manual sync at rest', () => {
    render(<SyncDetail onBack={jest.fn()} onResume={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a failed first pull', 'error' as StoreStatus, 'idle' as BgSyncStatus],
    ['a failed cycle', 'ready' as StoreStatus, 'error' as BgSyncStatus],
  ])('offers one Retry for %s — it recovers both', (_name, store, bg) => {
    setSync(store, bg, { lastError: 'Failed to fetch' });

    render(<SyncDetail onBack={jest.fn()} onResume={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['checking', 'checking' as StoreStatus, 'idle' as BgSyncStatus],
    ['the first pull', 'syncing-initial' as StoreStatus, 'idle' as BgSyncStatus],
    ['a cycle in flight', 'ready' as StoreStatus, 'syncing' as BgSyncStatus],
  ])('offers nothing to press during %s — there is nothing to trigger', (_name, store, bg) => {
    setSync(store, bg);

    render(<SyncDetail onBack={jest.fn()} onResume={jest.fn()} />);

    // Only the header's Back button remains.
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Back',
    ]);
  });

  it('explains a quota refusal with its count, and offers no retry', () => {
    setSync('ready', 'blocked-capacity', { blockedCount: 12 });

    render(<SyncDetail onBack={jest.fn()} onResume={jest.fn()} />);

    expect(screen.getByText(/12 changes can’t sync/)).toBeTruthy();
    // The cycle completed; only freeing space clears this, so a Retry button
    // would send the user round a loop that cannot help.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  // An EXPIRED session (docs/sessions.md): nothing failed and nothing is lost, so no
  // Retry — a cycle could only earn the same answer. The one fix is a sign-in.
  it('offers the resume, and no retry, while the session is expired', () => {
    setSync('ready', 'paused');
    const onResume = jest.fn();

    render(<SyncDetail onBack={jest.fn()} onResume={onResume} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to resume' }));

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toMatch(/still here/);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  it('goes back to the save flow', () => {
    const onBack = jest.fn();
    render(<SyncDetail onBack={onBack} onResume={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

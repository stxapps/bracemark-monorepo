import * as React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, render } from '@testing-library/react-native';

import type { StoreStatus } from '@stxapps/shared';

import { ShareBridge } from './share-bridge';

// ShareBridge sits above InitialSyncGate in the (app) layout, so it is mounted —
// and its foreground listener armed — for the whole of a first sync. What these
// cases pin is the one thing about that which fails in silence: a drain that
// runs before the store is ready lands its drafts with everything it hands on
// switched off. `extractNow` returns at once until the store is ready, and the
// outbox is empty by the time it would not, so the share never gets its page
// fetch — no error, no pending count, and at extraction mode `saves` no later
// pass that could make up for it.
//
// A first sync is the long version of that window, not the common one. The
// status is `checking` at the start of EVERY launch, and the mount pass runs
// inside it — so each not-ready status gets the case, and `checking` is the one
// that stands for a share found by a cold start.
//
// The Android share activity's handoff comes in through the same pass and is
// held by the same line (share-store's takeShareHandoffs): no draft to drain
// there, but the same page fetch owed.

let mockStoreStatus: StoreStatus = 'ready';
const mockRequestSync = jest.fn();
const mockExtractNow = jest.fn();
const mockDrainShareOutbox = jest.fn<Promise<string[]>, [{ keepReadMode?: boolean }?]>();
let mockKeptCopies = false;
const mockReadSettingsGeneral = jest.fn<Promise<object | undefined>, []>();
const mockTakeShareHandoffs = jest.fn<string[], []>();
const mockRefreshShareTaxonomy = jest.fn<Promise<void>, []>();

jest.mock('@stxapps/expo-react', () => ({
  drainShareOutbox: (options?: { keepReadMode?: boolean }) => mockDrainShareOutbox(options),
  readSettingsGeneral: () => mockReadSettingsGeneral(),
  useEntitlements: () => ({ entitlements: { keptCopies: mockKeptCopies } }),
  takeShareHandoffs: () => mockTakeShareHandoffs(),
  refreshShareTaxonomy: () => mockRefreshShareTaxonomy(),
  useSync: () => ({
    storeStatus: mockStoreStatus,
    lastSyncAt: null,
    localWriteNonce: 0,
    requestSync: mockRequestSync,
  }),
  useExtraction: () => ({ extractNow: mockExtractNow }),
}));

const DRAFT_PATH = 'links/l_shared.enc';
const HANDOFF_PATH = 'links/l_shared_android.enc';

// Every status the gate is closed in. Typed against the union so a status added
// to it has to be placed here or the file stops compiling.
const NOT_READY = ['checking', 'syncing-initial', 'error'] as const satisfies readonly Exclude<
  StoreStatus,
  'ready'
>[];

// The listeners the component has registered and not yet removed, so a
// foreground can be delivered to exactly what is live.
let listeners: Set<(state: AppStateStatus) => void>;

// Let a pass run to its end: the drain, the snapshot, then the two kicks.
const settle = () => act(async () => undefined);

async function foreground() {
  for (const listener of listeners) listener('active');
  await settle();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStoreStatus = 'ready';
  mockDrainShareOutbox.mockResolvedValue([DRAFT_PATH]);
  mockKeptCopies = false;
  mockReadSettingsGeneral.mockResolvedValue(undefined);
  mockTakeShareHandoffs.mockReturnValue([]);
  mockRefreshShareTaxonomy.mockResolvedValue(undefined);
  listeners = new Set();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    const handler = listener as (state: AppStateStatus) => void;
    listeners.add(handler);
    return { remove: () => listeners.delete(handler) } as ReturnType<
      typeof AppState.addEventListener
    >;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

it.each(NOT_READY)(
  'leaves the outbox alone while the store is %s, then drains what waited',
  async (status) => {
    mockStoreStatus = status;
    const view = render(<ShareBridge />);
    await settle();
    await foreground();

    expect(mockDrainShareOutbox).not.toHaveBeenCalled();
    expect(mockTakeShareHandoffs).not.toHaveBeenCalled();
    expect(mockRequestSync).not.toHaveBeenCalled();
    expect(mockExtractNow).not.toHaveBeenCalled();
    // The control for the four above: the passes did run. The snapshot is not
    // held back with the drain — its existence is how the sheet knows there is a
    // session.
    expect(mockRefreshShareTaxonomy).toHaveBeenCalledTimes(2);

    // The gate opens. No foreground, no remount: the pass that was skipped runs.
    mockStoreStatus = 'ready';
    view.rerender(<ShareBridge />);
    await settle();

    expect(mockDrainShareOutbox).toHaveBeenCalledTimes(1);
    expect(mockRequestSync).toHaveBeenCalledTimes(1);
    expect(mockExtractNow).toHaveBeenCalledWith([DRAFT_PATH]);
  },
);

it('gives what the Android share activity handed off the same two kicks', async () => {
  // No outbox on Android, so the drain has nothing; the marker is all there is.
  mockDrainShareOutbox.mockResolvedValue([]);
  mockTakeShareHandoffs.mockReturnValue([HANDOFF_PATH]);
  render(<ShareBridge />);
  await settle();

  expect(mockRequestSync).toHaveBeenCalledTimes(1);
  expect(mockExtractNow).toHaveBeenCalledWith([HANDOFF_PATH]);
});

it('drains on mount and on each return to the foreground once the store is ready', async () => {
  render(<ShareBridge />);
  await settle();
  expect(mockDrainShareOutbox).toHaveBeenCalledTimes(1);

  await foreground();
  expect(mockDrainShareOutbox).toHaveBeenCalledTimes(2);
  expect(mockExtractNow).toHaveBeenCalledTimes(2);
});

it('kicks nothing when the outbox was empty and nothing was handed off', async () => {
  mockDrainShareOutbox.mockResolvedValue([]);
  render(<ShareBridge />);
  await settle();

  expect(mockDrainShareOutbox).toHaveBeenCalledTimes(1);
  expect(mockTakeShareHandoffs).toHaveBeenCalledTimes(1);
  expect(mockRequestSync).not.toHaveBeenCalled();
  expect(mockExtractNow).not.toHaveBeenCalled();
});

// A Safari share can carry the page's read-mode copy; whether it is kept is the
// account's call at the drain — the plan and the synced setting, read from the store.
describe('the read-mode copy a Safari draft carries', () => {
  const keepAsked = () => mockDrainShareOutbox.mock.calls.at(-1)?.[0]?.keepReadMode;

  test('kept on a plan with copies when the setting is at its default', async () => {
    mockKeptCopies = true;
    render(<ShareBridge />);
    await settle();
    expect(keepAsked()).toBe(true);
  });

  test('not kept when the user turned read mode off', async () => {
    mockKeptCopies = true;
    mockReadSettingsGeneral.mockResolvedValue({
      keepReadModeOnSave: false,
      createdAt: 1,
      updatedAt: 1,
    });
    render(<ShareBridge />);
    await settle();
    expect(keepAsked()).toBe(false);
  });

  test('not kept without the plan, and the setting is not even read', async () => {
    render(<ShareBridge />);
    await settle();
    expect(keepAsked()).toBe(false);
    expect(mockReadSettingsGeneral).not.toHaveBeenCalled();
  });
});

// Specs for the one-slot pin moves. Pins carry no `listId` — one global rank
// order, which every view filters down to the pins matching it (docs/
// client-queries.md, _the pinned overlay_) — so "one slot" has to mean one slot
// in the section the user is LOOKING AT. Stepping one slot through the global
// order instead is silent: past a pin from another list, or a dangling pin
// whose link is gone, the write lands and the view doesn't change.
//
// The reads/writes are stubbed at the data modules; the rank arithmetic is the
// real code, and each assertion reads back the order the view would render.

import { act, renderHook } from '@testing-library/react-native';

import { compareRank, type LinkItem, LINKS_PREFIX, pathFromId } from '@stxapps/shared';

import type { PinItem } from '../data/queries';
import { usePinMutations } from './use-pin-mutations';

let mockPins: PinItem[] = [];
const mockWritePin = jest.fn(
  (_username: string, pin: PinItem, patch: Partial<PinItem>): Promise<void> => {
    mockPins = mockPins.map((p) => (p.id === pin.id ? { ...p, ...patch } : p));
    return Promise.resolve();
  },
);

jest.mock('../contexts/auth-provider', () => ({ useAuth: () => ({ username: 'alice' }) }));
jest.mock('../contexts/sync-provider', () => ({ useSync: () => ({ requestSync: jest.fn() }) }));
// The batched pair stands in for one transaction each: a whole run lands at once.
const mockBulkWritePins = jest.fn((_username: string, pins: PinItem[]): Promise<void> => {
  const ids = new Set(pins.map((p) => p.id));
  mockPins = [...mockPins.filter((p) => !ids.has(p.id)), ...pins];
  return Promise.resolve();
});
const mockBulkDeletePins = jest.fn((_username: string, ids: readonly string[]): Promise<void> => {
  mockPins = mockPins.filter((p) => !ids.includes(p.id));
  return Promise.resolve();
});

jest.mock('../data/mutations', () => ({
  writePin: (username: string, pin: PinItem, patch: Partial<PinItem>) =>
    mockWritePin(username, pin, patch),
  deletePin: jest.fn(),
  bulkWritePins: (username: string, pins: PinItem[]) => mockBulkWritePins(username, pins),
  bulkDeletePins: (username: string, ids: readonly string[]) => mockBulkDeletePins(username, ids),
}));
jest.mock('../data/queries', () => ({
  linkIdOf: jest.requireActual('@stxapps/shared').linkIdOf,
  readPins: () => Promise.resolve(mockPins.map((p) => ({ ...p }))),
}));

function link(id: string): LinkItem {
  return { path: pathFromId(id, LINKS_PREFIX) } as LinkItem;
}

// Pins in ascending rank order: a0 < a1 < …
function seed(ids: string[]): void {
  mockPins = ids.map((id, i) => ({
    id,
    rank: `a${i}`,
    createdAt: 1,
    updatedAt: 1,
    path: `pins/${id}.enc`,
  }));
}

// The pinned section as a view showing only `visible` renders it.
function viewOrder(visible: string[]): string[] {
  return [...mockPins]
    .sort(compareRank)
    .map((p) => p.id)
    .filter((id) => visible.includes(id));
}

beforeEach(() => {
  mockWritePin.mockClear();
  mockBulkWritePins.mockClear();
  mockBulkDeletePins.mockClear();
});

it('moves down past the visible neighbour, not a hidden pin from another list', async () => {
  // `h` is pinned but lives in another list, so this view shows [a, b].
  seed(['a', 'h', 'b']);
  const { result } = renderHook(() => usePinMutations());

  await act(() => result.current.moveDown(link('a'), link('b')));

  expect(viewOrder(['a', 'b'])).toEqual(['b', 'a']);
});

it('moves up past the visible neighbour, not a hidden pin from another list', async () => {
  seed(['a', 'h', 'b']);
  const { result } = renderHook(() => usePinMutations());

  await act(() => result.current.moveUp(link('b'), link('a')));

  expect(viewOrder(['a', 'b'])).toEqual(['b', 'a']);
});

it('keeps the rest of the visible section in order', async () => {
  seed(['a', 'b', 'h', 'c', 'd']);
  const { result } = renderHook(() => usePinMutations());

  await act(() => result.current.moveDown(link('b'), link('c')));

  expect(viewOrder(['a', 'b', 'c', 'd'])).toEqual(['a', 'c', 'b', 'd']);
  expect(mockWritePin).toHaveBeenCalledTimes(1);
});

it('moves into the slot between two pins whose ranks tie', async () => {
  // Pinning mints the head key, so two devices pinning offline mint the SAME
  // one and the pair syncs down tied (the sort breaks it by id). No key fits
  // between equal keys — the move has to re-key one of the pair as well, where
  // a single-key mint threw fractional-indexing's bare " >= " at the user.
  seed(['a', 'b', 'c']);
  mockPins = mockPins.map((p) => (p.id === 'b' ? { ...p, rank: 'a0' } : p));
  const { result } = renderHook(() => usePinMutations());

  await act(() => result.current.moveUp(link('c'), link('b')));

  expect(viewOrder(['a', 'b', 'c'])).toEqual(['a', 'c', 'b']);
  expect(mockWritePin).toHaveBeenCalledTimes(2);
});

it('writes nothing when the neighbour has since been unpinned', async () => {
  seed(['a', 'b']);
  const { result } = renderHook(() => usePinMutations());

  await act(() => result.current.moveDown(link('a'), link('gone')));

  expect(mockWritePin).not.toHaveBeenCalled();
});

// A selection's Pin: one write for the whole run, which lands above every pin
// outside it in the order given — what a loop of `pin` over the REVERSED run
// produced one write at a time.
describe('pinMany', () => {
  it('puts the run on top, first link topmost, in one write', async () => {
    seed(['x', 'y']);
    const { result } = renderHook(() => usePinMutations());

    await act(() => result.current.pinMany([link('a'), link('b'), link('c')]));

    expect(viewOrder(['a', 'b', 'c', 'x', 'y'])).toEqual(['a', 'b', 'c', 'x', 'y']);
    expect(mockBulkWritePins).toHaveBeenCalledTimes(1);
    expect(mockWritePin).not.toHaveBeenCalled();
  });

  it('moves a pin already in the run to its place in the run', async () => {
    // `b` is pinned below `x`; pinning it again re-keys it, as `pin` would.
    seed(['x', 'b']);
    const { result } = renderHook(() => usePinMutations());

    await act(() => result.current.pinMany([link('b'), link('a')]));

    expect(viewOrder(['a', 'b', 'x'])).toEqual(['b', 'a', 'x']);
  });

  it('goes above a head pair whose ranks tie', async () => {
    seed(['x', 'y']);
    mockPins = mockPins.map((p) => ({ ...p, rank: 'a0' }));
    const { result } = renderHook(() => usePinMutations());

    await act(() => result.current.pinMany([link('a'), link('b')]));

    expect(viewOrder(['a', 'b', 'x', 'y'])).toEqual(['a', 'b', 'x', 'y']);
  });

  it('writes a link named twice once, and nothing for an empty run', async () => {
    seed([]);
    const { result } = renderHook(() => usePinMutations());

    await act(() => result.current.pinMany([]));
    expect(mockBulkWritePins).not.toHaveBeenCalled();

    await act(() => result.current.pinMany([link('a'), link('a')]));
    expect(mockBulkWritePins.mock.calls[0][1].map((p) => p.id)).toEqual(['a']);
  });
});

describe('unpinMany', () => {
  it('unpins the run in one write and leaves the rest in order', async () => {
    seed(['a', 'b', 'c', 'd']);
    const { result } = renderHook(() => usePinMutations());

    await act(() => result.current.unpinMany([link('b'), link('d'), link('b')]));

    expect(mockBulkDeletePins).toHaveBeenCalledTimes(1);
    expect(mockBulkDeletePins.mock.calls[0][1]).toEqual(['b', 'd']);
    expect(viewOrder(['a', 'b', 'c', 'd'])).toEqual(['a', 'c']);
  });

  it('writes nothing for an empty run', async () => {
    seed(['a']);
    const { result } = renderHook(() => usePinMutations());

    await act(() => result.current.unpinMany([]));

    expect(mockBulkDeletePins).not.toHaveBeenCalled();
  });
});

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
jest.mock('../data/mutations', () => ({
  writePin: (username: string, pin: PinItem, patch: Partial<PinItem>) =>
    mockWritePin(username, pin, patch),
  deletePin: jest.fn(),
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

beforeEach(() => mockWritePin.mockClear());

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

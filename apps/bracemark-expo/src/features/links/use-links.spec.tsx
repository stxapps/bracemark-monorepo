import { useEffect } from 'react';
import { act, renderHook } from '@testing-library/react-native';

import type { LinkItem, LinksResult } from '@stxapps/expo-react';
import { emptyQuery } from '@stxapps/shared';

import { useLinks } from './use-links';

let mockQuery = emptyQuery();
let mockLocked = new Set<string>();
let mockNonce = 0;
let mockRows: LinkItem[] = [];
let mockRefresh: () => Promise<void>;
let mockBlockRead: Promise<void> | undefined;

jest.mock('@stxapps/expo-react', () => ({
  excludeLists: (jest.requireActual('@stxapps/shared') as typeof import('@stxapps/shared'))
    .excludeLists,
  useLocks: () => ({ lockedListIds: mockLocked }),
  useSync: () => ({ localWriteNonce: mockNonce }),
  readLinks: async (query: LinksResult['query'], limit: number) => {
    const links = mockRows;
    await mockBlockRead;
    return { links, query, limit, total: links.length, pinnedCount: 0, hasMore: false };
  },
  // Control when a live read starts and resolves; holds and pauses have their
  // own hook tests. This pins what the links screen does with a delayed result.
  useLiveRead: (read: () => Promise<unknown>, deps: unknown[]) => {
    const react = jest.requireActual('react') as typeof import('react');
    const [value, setValue] = react.useState<unknown>();
    react.useEffect(() => {
      mockRefresh = async () => setValue(await read());
      void mockRefresh();
    }, deps);
    return value;
  },
}));
jest.mock('./page-provider', () => ({ useLinksPage: () => ({ query: mockQuery }) }));
jest.mock('./view-state-provider', () => ({ useLinksViewState: () => ({ engaged: true }) }));

const rows = (title: string) => [
  { path: 'links/a.enc', customTitle: title, updatedAt: mockNonce + 1 } as LinkItem,
];

beforeEach(() => {
  jest.useFakeTimers();
  mockQuery = emptyQuery();
  mockLocked = new Set();
  mockNonce = 0;
  mockRows = rows('Original');
  mockBlockRead = undefined;
});
afterEach(() => jest.useRealTimers());

async function mount() {
  const commits: ReturnType<typeof useLinks>[] = [];
  const view = renderHook(() => {
    const value = useLinks();
    useEffect(() => {
      commits.push(value);
    });
    return value;
  });
  await act(async () => undefined);
  return { ...view, commits };
}

it.each([2100, 60_000])(
  'promotes a local edit when the read resumes after %i ms',
  async (delay) => {
    const { result, rerender, commits } = await mount();
    mockNonce++;
    mockRows = rows('Edited');
    rerender(undefined);
    act(() => jest.advanceTimersByTime(delay));
    const before = commits.length;
    await act(async () => mockRefresh());
    expect(result.current.links[0].customTitle).toBe('Edited');
    expect(commits.slice(before).some((value) => value.hasPending)).toBe(false);

    // Acknowledging that edit must not disable staging for subsequent remote changes.
    act(() => jest.advanceTimersByTime(3000));
    mockRows = [{ ...mockRows[0], customTitle: 'Remote', updatedAt: 99 }];
    await act(async () => mockRefresh());
    expect(result.current.links[0].customTitle).toBe('Edited');
    expect(result.current.hasPending).toBe(true);
  },
);

it('does not acknowledge an edit with a read that started before it', async () => {
  const { result, rerender } = await mount();
  let finish!: () => void;
  mockBlockRead = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stale = mockRefresh();
  mockNonce++;
  mockRows = rows('Edited');
  rerender(undefined);
  act(() => jest.advanceTimersByTime(3000));
  await act(async () => {
    finish();
    await stale;
  });
  expect(result.current.links[0].customTitle).toBe('Original');
  mockBlockRead = undefined;
  await act(async () => mockRefresh());
  expect(result.current.links[0].customTitle).toBe('Edited');
  expect(result.current.hasPending).toBe(false);
});

// The row key's namespace (main.tsx, above `keyExtractor`): FlashList anchors on
// that key, so `viewId` has to change in the very commit that swaps the rows for
// another view's, and in no other. Early, and the old rows lose their anchor
// under a reader for the length of the read; late, the new rows anchor on the
// old view's row and the list jumps; and a change for anything short of a new
// view takes away the position the anchor is there to hold.
describe('viewId', () => {
  it("moves with the new view's rows, not with the request for them", async () => {
    const { result, rerender } = await mount();
    const before = result.current.viewId;

    let finish!: () => void;
    mockBlockRead = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mockQuery = emptyQuery();
    mockRows = rows('Next view');
    rerender(undefined);
    await act(async () => undefined);
    expect(result.current.links[0].customTitle).toBe('Original');
    expect(result.current.viewId).toBe(before);

    await act(async () => {
      finish();
      await mockBlockRead;
    });
    await act(async () => undefined);
    expect(result.current.links[0].customTitle).toBe('Next view');
    expect(result.current.viewId).not.toBe(before);
  });

  it('holds across a page of Show more', async () => {
    const { result } = await mount();
    const before = result.current.viewId;

    mockRows = rows('Longer page');
    await act(async () => result.current.showMore());
    await act(async () => undefined);
    expect(result.current.links[0].customTitle).toBe('Longer page');
    expect(result.current.viewId).toBe(before);
  });

  it('holds when a list locks, which re-reads the same view', async () => {
    const { result, rerender } = await mount();
    const before = result.current.viewId;

    mockLocked = new Set(['seed-list-00']);
    mockRows = rows('Fewer rows');
    rerender(undefined);
    await act(async () => undefined);
    expect(result.current.links[0].customTitle).toBe('Fewer rows');
    expect(result.current.viewId).toBe(before);
  });
});

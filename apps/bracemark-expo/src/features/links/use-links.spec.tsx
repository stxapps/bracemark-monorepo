import { useEffect } from 'react';
import { act, renderHook } from '@testing-library/react-native';

import type { LinkItem, LinksResult } from '@stxapps/expo-react';
import { emptyQuery } from '@stxapps/shared';

import { useLinks } from './use-links';

const mockQuery = emptyQuery();
const mockLocked = new Set<string>();
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

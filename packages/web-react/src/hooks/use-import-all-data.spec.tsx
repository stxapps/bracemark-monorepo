/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react';

import type { ImportQuotaAnswer, ImportQuotaResolver } from '@stxapps/shared';

import { useImportAllData } from './use-import-all-data';

const mockApi = {};
const mockRequestSync = jest.fn();
const mockImport = jest.fn();
jest.mock('@stxapps/react', () => ({ useApiClient: () => mockApi }));
jest.mock('../contexts/auth-provider', () => ({ useAuth: () => ({ username: 'alice' }) }));
jest.mock('../contexts/sync-provider', () => ({
  useSync: () => ({ requestSync: mockRequestSync }),
}));
jest.mock('../data/session-store', () => ({ getSession: () => ({ encryptionKey: {} }) }));
jest.mock('./use-entitlements', () => ({
  useEntitlements: () => ({ entitlements: { maxLinks: 200 } }),
}));
jest.mock('../data/import-all-data', () => ({
  importAllData: (options: unknown) => mockImport(options),
}));

const file = new File([], 'bookmarks.txt');
const prompt = { newCount: 300, existingCount: 0, maxLinks: 200, room: 200 };
let answer: ImportQuotaAnswer | undefined;
let ask: () => Promise<void>;
let settled: boolean;

beforeEach(() => {
  answer = undefined;
  settled = false;
  mockRequestSync.mockClear();
  mockImport.mockImplementation(
    async ({ onQuotaPrompt }: { onQuotaPrompt: ImportQuotaResolver }) => {
      ask = async () => {
        answer = await onQuotaPrompt(prompt);
      };
      await ask();
      settled = true;
      if (answer === 'cancel') throw new Error('cancelled');
      return { linkCount: 200 };
    },
  );
});

it('settles an unanswered quota prompt when its screen unmounts', async () => {
  const { result, unmount } = renderHook(() => useImportAllData());
  act(() => result.current.run(file));
  expect(result.current.state.phase).toBe('quota');
  unmount();
  await act(async () => undefined);
  expect(answer).toBe('cancel');
  expect(settled).toBe(true);
  expect(mockRequestSync).not.toHaveBeenCalled();
});

it('cancels a prompt that arrives after the screen has already unmounted', async () => {
  let continueParse!: () => void;
  const parsing = new Promise<void>((resolve) => {
    continueParse = resolve;
  });
  mockImport.mockImplementation(
    async ({ onQuotaPrompt }: { onQuotaPrompt: ImportQuotaResolver }) => {
      await parsing;
      answer = await onQuotaPrompt(prompt);
      settled = true;
      throw new Error('cancelled');
    },
  );
  const { result, unmount } = renderHook(() => useImportAllData());
  act(() => result.current.run(file));
  unmount();
  await act(async () => continueParse());
  expect(answer).toBe('cancel');
  expect(settled).toBe(true);
});

it('still resumes an accepted import and requests its sync', async () => {
  const { result } = renderHook(() => useImportAllData());
  act(() => result.current.run(file));
  await act(async () => result.current.answerQuota('import-what-fits'));
  expect(answer).toBe('import-what-fits');
  expect(result.current.state.phase).toBe('done');
  expect(mockRequestSync).toHaveBeenCalledTimes(1);
});

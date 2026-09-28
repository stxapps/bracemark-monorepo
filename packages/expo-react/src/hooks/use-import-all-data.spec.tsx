import { act, renderHook } from '@testing-library/react-native';

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

const file = { uri: 'file:///bookmarks.txt', name: 'bookmarks.txt' };
const prompt = { newCount: 300, existingCount: 0, maxLinks: 200, room: 200 };
let answer: ImportQuotaAnswer | undefined;
let ask: () => Promise<void>;
let settled: boolean;

beforeEach(() => {
  answer = undefined;
  settled = false;
  mockRequestSync.mockClear();
  mockImport.mockClear();
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

// The run is the app's, not the view's: leaving Settings → Data doesn't stop the
// orchestrator, so a view mounted meanwhile must see it rather than offer a
// second run that would dedupe against a half-written library.
describe('a run that outlives its view', () => {
  let finish: () => void;

  beforeEach(() => {
    const writing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mockImport.mockImplementation(
      async ({ onProgress }: { onProgress: (progress: object) => void }) => {
        onProgress({ step: 'items', done: 200, total: 1000 });
        await writing;
        return { linkCount: 1000 };
      },
    );
  });

  it('shows the next view its progress and refuses to start a second', async () => {
    const first = renderHook(() => useImportAllData());
    act(() => first.result.current.run(file));
    first.unmount();

    const second = renderHook(() => useImportAllData());
    expect(second.result.current.state).toEqual({
      phase: 'running',
      step: 'items',
      done: 200,
      total: 1000,
    });
    act(() => second.result.current.run(file));
    expect(mockImport).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    expect(second.result.current.state.phase).toBe('done');
    expect(mockRequestSync).toHaveBeenCalledTimes(1);
  });

  it('keeps the receipt of a run that finished with no view for the next one', async () => {
    const first = renderHook(() => useImportAllData());
    act(() => first.result.current.run(file));
    first.unmount();
    await act(async () => finish());

    const second = renderHook(() => useImportAllData());
    expect(second.result.current.state).toEqual({
      phase: 'done',
      outcome: { linkCount: 1000 },
    });
    second.unmount();

    // Seen once; the view after that starts over.
    const third = renderHook(() => useImportAllData());
    expect(third.result.current.state.phase).toBe('idle');
  });

  it('starts the next view idle once the watched run has settled', async () => {
    const first = renderHook(() => useImportAllData());
    act(() => first.result.current.run(file));
    await act(async () => finish());
    expect(first.result.current.state.phase).toBe('done');
    first.unmount();

    const second = renderHook(() => useImportAllData());
    expect(second.result.current.state.phase).toBe('idle');
    // `writing` is already resolved, so this run settles at once — inside act, so its
    // `done` lands in the test rather than after it.
    await act(async () => second.result.current.run(file));
    expect(mockImport).toHaveBeenCalledTimes(2);
  });
});

// The orchestrator spec proves the destructive ordering and survivor set. This
// hook spec pins the UI-only half: a links screen can remain mounted and
// scrolled behind Settings, so a successful wipe must open SyncProvider's
// local-write grace and promote the empty live result immediately.

import { act, renderHook, waitFor } from '@testing-library/react-native';

import { DeleteAllAccountChangedError } from '@stxapps/shared';

import { useDeleteAllData } from './use-delete-all-data';

const mockApi = {};
const mockRequestSync = jest.fn();
const mockDeleteAllData = jest.fn();
let mockUsername: string | null = 'alice';

jest.mock('@stxapps/react', () => ({ useApiClient: () => mockApi }));
jest.mock('../contexts/auth-provider', () => ({
  useAuth: () => ({ username: mockUsername }),
}));
jest.mock('../contexts/sync-provider', () => ({
  useSync: () => ({ requestSync: mockRequestSync }),
}));
jest.mock('../data/delete-all-data', () => ({
  deleteAllData: (args: unknown) => mockDeleteAllData(args),
}));

beforeEach(() => {
  mockUsername = 'alice';
  mockRequestSync.mockClear();
  mockDeleteAllData.mockReset();
});

it('marks a successful wipe as a local write so mounted link results promote immediately', async () => {
  mockDeleteAllData.mockResolvedValue({ deletedCount: 4 });
  const { result } = renderHook(() => useDeleteAllData());

  act(() => result.current.run());

  await waitFor(() => expect(result.current.state.phase).toBe('done'));
  expect(mockRequestSync).toHaveBeenCalledTimes(1);
});

it('does not mark a failed wipe as a local write', async () => {
  mockDeleteAllData.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useDeleteAllData());

  act(() => result.current.run());

  await waitFor(() => expect(result.current.state.phase).toBe('error'));
  expect(mockRequestSync).not.toHaveBeenCalled();
});

it('exposes whether the running wipe is waiting for sync or deleting', () => {
  let reportStep: ((step: 'waiting-for-sync' | 'deleting') => void) | undefined;
  mockDeleteAllData.mockImplementation(
    (args: { onStep: (step: 'waiting-for-sync' | 'deleting') => void }) => {
      reportStep = args.onStep;
      return new Promise<never>(() => undefined);
    },
  );
  const { result } = renderHook(() => useDeleteAllData());

  act(() => result.current.run());
  expect(result.current.state).toEqual({ phase: 'running', step: 'deleting' });

  act(() => reportStep?.('waiting-for-sync'));
  expect(result.current.state).toEqual({ phase: 'running', step: 'waiting-for-sync' });

  act(() => reportStep?.('deleting'));
  expect(result.current.state).toEqual({ phase: 'running', step: 'deleting' });
});

// A view's tick, and an error's "try again", were given for the account on screen, and a
// run for any other account would be that account's wipe on the previous one's
// confirmation. On web the account can change under a mounted view (its spec carries the
// case). Here a teardown unmounts the view first, so these pin the state machine the two
// hooks share rather than a path expo reaches.
describe('when the account changes under the view', () => {
  it('runs for the account the view was opened for', () => {
    mockDeleteAllData.mockReturnValue(new Promise<never>(() => undefined));
    const { result } = renderHook(() => useDeleteAllData());

    act(() => result.current.run());

    expect(mockDeleteAllData).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice' }));
  });

  it('refuses a run for another account, and starts nothing', () => {
    const { result, rerender } = renderHook(() => useDeleteAllData());
    mockUsername = 'bob';
    rerender(undefined);

    act(() => result.current.run());

    expect(mockDeleteAllData).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ phase: 'account-changed', serverWiped: false });
  });

  // The retry an error invites is the one that matters: the box is still ticked and the
  // button is live.
  it('refuses the retry after a failed run, once the account is another', async () => {
    mockDeleteAllData.mockRejectedValue(new Error('offline'));
    const { result, rerender } = renderHook(() => useDeleteAllData());
    act(() => result.current.run());
    await waitFor(() => expect(result.current.state.phase).toBe('error'));

    mockUsername = 'bob';
    rerender(undefined);
    act(() => result.current.run());

    expect(mockDeleteAllData).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ phase: 'account-changed', serverWiped: false });
  });

  // The flow's two refusals are their own state, not `error`: what the view may say and
  // offer differs, and one of them follows a server wipe that DID happen.
  it.each([true, false])(
    'reports the flow’s refusal as an account change (server wiped: %s), not a failure',
    async (serverWiped) => {
      mockDeleteAllData.mockRejectedValue(new DeleteAllAccountChangedError(serverWiped));
      const { result } = renderHook(() => useDeleteAllData());

      act(() => result.current.run());

      await waitFor(() =>
        expect(result.current.state).toEqual({ phase: 'account-changed', serverWiped }),
      );
      // Not this account's wipe to promote: the local store was left as it was.
      expect(mockRequestSync).not.toHaveBeenCalled();
    },
  );
});

// The orchestrator spec proves the destructive ordering and survivor set. This
// hook spec pins the UI-only half: a links screen can remain mounted and
// scrolled behind Settings, so a successful wipe must open SyncProvider's
// local-write grace and promote the empty live result immediately.

import { act, renderHook, waitFor } from '@testing-library/react-native';

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

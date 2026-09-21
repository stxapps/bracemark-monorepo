/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react';

import { useDeleteAllData } from './use-delete-all-data';

const mockApi = {};
const mockDeleteAllData = jest.fn();

jest.mock('@stxapps/react', () => ({ useApiClient: () => mockApi }));
jest.mock('../contexts/auth-provider', () => ({
  useAuth: () => ({ username: 'alice' }),
}));
jest.mock('../data/delete-all-data', () => ({
  deleteAllData: (args: unknown) => mockDeleteAllData(args),
}));

beforeEach(() => {
  mockDeleteAllData.mockReset();
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

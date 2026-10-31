/**
 * @jest-environment jsdom
 */
// bracemark-web's SyncProvider with the dangling-extraction sweep as its after-cycle
// work. WHEN the work runs is the engine's to pin (sync/engine.spec.ts, _the
// after-cycle work_); what this wrapper owns is HOW OFTEN — once per session and
// account — and that a sweep that removed something asks for the cycle that pushes it.

import { render } from '@testing-library/react';

import { SyncProviderWithSweep } from './sync-provider-with-sweep';

let mockAfterCycle: ((username: string) => Promise<boolean>) | undefined;
const mockSweep = jest.fn((_username: string) => Promise.resolve(0));
const mockOrphanSweep = jest.fn((_username: string) => Promise.resolve(0));
jest.mock('@stxapps/web-react', () => ({
  SyncProvider: ({
    children,
    afterCycle,
  }: {
    children: React.ReactNode;
    afterCycle?: (username: string) => Promise<boolean>;
  }) => {
    mockAfterCycle = afterCycle;
    return children;
  },
  sweepDanglingExtractions: (username: string) => mockSweep(username),
  sweepOrphanFiles: (username: string) => mockOrphanSweep(username),
}));

beforeEach(() => {
  mockAfterCycle = undefined;
  mockSweep.mockReset();
  mockSweep.mockResolvedValue(0);
  mockOrphanSweep.mockReset();
  mockOrphanSweep.mockResolvedValue(0);
});

it('sweeps after the first cycle only, not after every one', async () => {
  render(<SyncProviderWithSweep>{null}</SyncProviderWithSweep>);

  await expect(mockAfterCycle?.('alice')).resolves.toBe(false);
  await expect(mockAfterCycle?.('alice')).resolves.toBe(false);

  expect(mockSweep).toHaveBeenCalledTimes(1);
  expect(mockSweep).toHaveBeenCalledWith('alice');
});

it('asks for one more cycle when it swept something, to push the deletes', async () => {
  mockSweep.mockResolvedValue(2);
  render(<SyncProviderWithSweep>{null}</SyncProviderWithSweep>);

  await expect(mockAfterCycle?.('alice')).resolves.toBe(true);
});

// The latch is set before the sweep runs: a failed sweep is not retried within the
// session (it changes nothing the user sees, and the next session runs it again).
it('does not retry a failed sweep within the session', async () => {
  mockSweep.mockRejectedValueOnce(new Error('sweep failed'));
  render(<SyncProviderWithSweep>{null}</SyncProviderWithSweep>);

  await expect(mockAfterCycle?.('alice')).rejects.toThrow('sweep failed');
  await expect(mockAfterCycle?.('alice')).resolves.toBe(false);

  expect(mockSweep).toHaveBeenCalledTimes(1);
});

it('sweeps again for another account in the same mount', async () => {
  render(<SyncProviderWithSweep>{null}</SyncProviderWithSweep>);

  await mockAfterCycle?.('alice');
  await mockAfterCycle?.('bob');

  expect(mockSweep.mock.calls).toEqual([['alice'], ['bob']]);
});

test('runs the orphaned-file sweep in the same slot, and a cycle follows when it swept', async () => {
  mockOrphanSweep.mockResolvedValue(3);
  render(<SyncProviderWithSweep>child</SyncProviderWithSweep>);

  await expect(mockAfterCycle?.('alice')).resolves.toBe(true);
  expect(mockOrphanSweep).toHaveBeenCalledWith('alice');
  // Once per session, like the dangling sweep.
  await expect(mockAfterCycle?.('alice')).resolves.toBe(false);
  expect(mockOrphanSweep).toHaveBeenCalledTimes(1);
});

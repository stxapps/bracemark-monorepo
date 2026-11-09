import * as React from 'react';
import { render } from '@testing-library/react-native';

import { SWEEP_EVERY_MS, SyncProviderWithSweep } from './sync-provider-with-sweep';

// bracemark-expo's SyncProvider with the two sweeps as its after-cycle work. WHEN
// the work runs is the engine's to pin (expo-react sync/engine.spec.ts); what this
// wrapper owns is HOW OFTEN, which is where it differs from web's: a mount here can
// last for days, so the latch reopens after SWEEP_EVERY_MS instead of lasting the
// mount. Without that, a dangling extraction outlives a long-lived process.

let mockAfterCycle: ((username: string) => Promise<boolean>) | undefined;
const mockSweep = jest.fn((_username: string) => Promise.resolve(0));
const mockOrphanSweep = jest.fn((_username: string) => Promise.resolve(0));
jest.mock('@stxapps/expo-react', () => ({
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

const NOW = 1_800_000_000_000;
let now = NOW;

beforeEach(() => {
  now = NOW;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  mockAfterCycle = undefined;
  mockSweep.mockReset();
  mockSweep.mockResolvedValue(0);
  mockOrphanSweep.mockReset();
  mockOrphanSweep.mockResolvedValue(0);
});

afterEach(() => jest.restoreAllMocks());

it('sweeps after the first cycle, not after every one', async () => {
  render(<SyncProviderWithSweep>{null}</SyncProviderWithSweep>);

  await expect(mockAfterCycle?.('alice')).resolves.toBe(false);
  await expect(mockAfterCycle?.('alice')).resolves.toBe(false);

  expect(mockSweep).toHaveBeenCalledTimes(1);
  expect(mockOrphanSweep).toHaveBeenCalledTimes(1);
});

it('sweeps again once the interval has passed in the same mount', async () => {
  render(<SyncProviderWithSweep>{null}</SyncProviderWithSweep>);
  await mockAfterCycle?.('alice');

  now = NOW + SWEEP_EVERY_MS - 1;
  await mockAfterCycle?.('alice');
  expect(mockSweep).toHaveBeenCalledTimes(1);

  now = NOW + SWEEP_EVERY_MS;
  await mockAfterCycle?.('alice');
  expect(mockSweep).toHaveBeenCalledTimes(2);
});

it('asks for one more cycle when either sweep removed something, to push the deletes', async () => {
  mockOrphanSweep.mockResolvedValue(3);
  render(<SyncProviderWithSweep>{null}</SyncProviderWithSweep>);

  await expect(mockAfterCycle?.('alice')).resolves.toBe(true);
});

// The latch is set before the sweep runs: a failed sweep waits for the next window
// rather than running on every cycle.
it('does not retry a failed sweep on the next cycle', async () => {
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

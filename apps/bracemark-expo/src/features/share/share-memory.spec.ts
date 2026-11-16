// The JS half of the sheet's memory log (share-memory.ts). What a device run
// reads is native — the footprint, the PSS — and cannot be had under jest. What
// can be pinned is the contract the line's reader leans on: a per-sheet mount
// count in the label, so laps read off the log; a fresh count for every sheet,
// because Android's share root rides the app's long-lived process; and NUMBERS
// ONLY across the bridge, so nothing of the share can reach the device log.

import { beginShareMemory, markShareMemory } from './share-memory';

const mockMark = jest.fn();
jest.mock('expo-modules-core', () => ({
  ...jest.requireActual('expo-modules-core'),
  requireOptionalNativeModule: (name: string) =>
    name === 'BracemarkShareMemory'
      ? { mark: (label: string, stats: unknown) => mockMark(label, stats) }
      : null,
}));

beforeEach(() => mockMark.mockClear());

describe('markShareMemory', () => {
  it('counts each screen’s mounts within a sheet, so a lap reads off the label', () => {
    beginShareMemory();
    for (const label of [
      'loading',
      'compose',
      'list-picker',
      'compose',
      'tags-picker',
      'compose',
    ]) {
      markShareMemory(label);
    }
    expect(mockMark.mock.calls.map(([label]) => label)).toEqual([
      'loading#1',
      'compose#1',
      'list-picker#1',
      'compose#2',
      'tags-picker#1',
      'compose#3',
    ]);
  });

  it('starts the counts over for every sheet', () => {
    beginShareMemory();
    markShareMemory('compose');
    markShareMemory('compose');
    beginShareMemory();
    markShareMemory('compose');
    expect(mockMark.mock.calls.at(-1)?.[0]).toBe('compose#1');
  });

  it('sends numbers only', () => {
    beginShareMemory();
    markShareMemory('compose');
    const [, stats] = mockMark.mock.calls[0] as [string, Record<string, unknown>];
    for (const value of Object.values(stats)) expect(typeof value).toBe('number');
  });
});

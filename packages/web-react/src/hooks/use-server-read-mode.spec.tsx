/**
 * @jest-environment jsdom
 */
import { renderHook } from '@testing-library/react';

import { useServerReadMode } from './use-server-read-mode';

// THE PRIVACY GATE for the reader's _Keep a read-mode copy_: the link's address goes to
// `bracemark-extractor` only with the `serverReadMode` opt-in on. Its OWN opt-in — the
// preview one (`serverExtraction`) must neither open it nor be needed for it — because
// the two consent to different things (entities.ts): previews send every pending link as
// it comes into view, read mode one link per press.
//
// `needsOptIn` is the reader's cue to offer the switch, so it must hold only where
// turning the switch on would make the action work — never on a plan without
// `keptCopies`, nor in a build with no extractor.

let mockServerReadMode = false;
let mockServerExtraction = false;
let mockKeptCopies = true;
let mockClient: object | null = {};

jest.mock('@stxapps/react', () => ({ useExtractClient: () => mockClient }));
jest.mock('../contexts/auth-provider', () => ({ useAuth: () => ({ username: 'alice' }) }));
jest.mock('../contexts/sync-provider', () => ({
  useSync: () => ({ storeStatus: 'ready', requestSync: jest.fn() }),
}));
jest.mock('./use-settings', () => ({
  useSettings: () => ({
    serverReadMode: mockServerReadMode,
    serverExtraction: mockServerExtraction,
  }),
}));
jest.mock('./use-entitlements', () => ({
  useEntitlements: () => ({ entitlements: { keptCopies: mockKeptCopies } }),
}));
jest.mock('../lib/server-read-mode', () => ({ runServerReadMode: jest.fn() }));

beforeEach(() => {
  mockServerReadMode = false;
  mockServerExtraction = false;
  mockKeptCopies = true;
  mockClient = {};
});

const gate = () => {
  const { available, needsOptIn } = renderHook(() => useServerReadMode()).result.current;
  return { available, needsOptIn };
};

test('off by default: nothing available, the opt-in offered', () => {
  expect(gate()).toEqual({ available: false, needsOptIn: true });
});

test('the preview opt-in does not open it', () => {
  mockServerExtraction = true;
  expect(gate()).toEqual({ available: false, needsOptIn: true });
});

test('its own opt-in opens it, with previews off', () => {
  mockServerReadMode = true;
  expect(gate()).toEqual({ available: true, needsOptIn: false });
});

test('never offered where turning it on would not help', () => {
  mockKeptCopies = false;
  expect(gate()).toEqual({ available: false, needsOptIn: false });

  mockKeptCopies = true;
  mockClient = null;
  expect(gate()).toEqual({ available: false, needsOptIn: false });
});

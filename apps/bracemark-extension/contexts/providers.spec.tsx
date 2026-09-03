import { render } from '@testing-library/react';

import type { MirroredSyncState } from '../utils/mirrored-sync-state';
import { Providers } from './providers';

// The popup's provider tree. The one thing here that is neither wiring nor
// bracemark-web's tree repeated is the SHAPE of what it publishes to the sync
// context, and it has a failure mode with no error attached to it:
//
// The popup does NOT mount the sync engine — that lives in the background worker —
// so `ExternalSyncProvider` is fed from the storage mirror, and `requestSync` is a
// message rather than a cycle. `Providers` re-renders on every mirror update (each
// cycle toggles `bgSyncStatus` at least twice), so an inline arrow would hand every
// `useSync()` consumer a fresh `requestSync` each time. That is harmless for the
// editor hooks, which only call it from event handlers — and NOT harmless for
// App.tsx's mount kick, which depends on it: the effect would re-fire on every
// cycle and drive an endless syncing⇄synced loop. Nothing about that is a type
// error or a failed render; it is a popup that quietly never stops syncing.

const mockUseMirroredSyncState = jest.fn<MirroredSyncState, []>();
const mockSendMessage = jest.fn(async () => ({ ok: true }));

// Everything above the sync context is passed through: this spec is about what
// `Providers` computes, and the providers it nests are covered where they live.
jest.mock('@stxapps/react', () => ({
  ApiClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@stxapps/web-ui/contexts/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@stxapps/web-react', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  ExternalSyncProvider: (props: Record<string, unknown>) => {
    externalSyncProps.push(props);
    return props.children as React.ReactNode;
  },
}));
jest.mock('@/utils/api-client', () => ({ apiClient: { baseUrl: 'https://api.test' } }));
jest.mock('@/hooks/use-mirrored-sync-state', () => ({
  get useMirroredSyncState() {
    return mockUseMirroredSyncState;
  },
}));
jest.mock('@/utils/messages', () => ({
  get sendMessage() {
    return mockSendMessage;
  },
}));

// Every set of props the sync context was given, one per render.
const externalSyncProps: Record<string, unknown>[] = [];

const IDLE: MirroredSyncState = {
  storeStatus: 'ready',
  bgSyncStatus: 'idle',
  lastSyncAt: 1_700_000_000_000,
  lastError: null,
  blockedCount: 0,
};

// Two mirrors between them carrying a non-default value in every field, so a
// forwarded field that got dropped or hard-coded shows up rather than matching the
// context's own default.
const BLOCKED: MirroredSyncState = { ...IDLE, bgSyncStatus: 'blocked-capacity', blockedCount: 3 };
const FAILED: MirroredSyncState = {
  ...IDLE,
  bgSyncStatus: 'error',
  lastError: 'Failed to fetch',
};
const FIRST_PULL: MirroredSyncState = { ...IDLE, storeStatus: 'syncing-initial', lastSyncAt: null };

beforeEach(() => {
  jest.clearAllMocks();
  externalSyncProps.length = 0;
  mockUseMirroredSyncState.mockReturnValue(IDLE);
});

describe('Providers', () => {
  it.each([
    ['a settled cycle', IDLE],
    ['a quota refusal, with its count', BLOCKED],
    ['a failed cycle, with its message', FAILED],
    ['a first pull still gating the store', FIRST_PULL],
  ])('publishes the background’s mirror as the popup’s sync state: %s', (_name, mirror) => {
    mockUseMirroredSyncState.mockReturnValue(mirror);

    render(<Providers>ok</Providers>);

    expect(externalSyncProps[0]).toMatchObject(mirror);
  });

  it('keeps `requestSync` referentially stable while the mirror changes underneath it', () => {
    const { rerender } = render(<Providers>ok</Providers>);
    const first = externalSyncProps[0].requestSync;

    // One ordinary cycle: idle → syncing → idle, i.e. two re-renders of this tree.
    mockUseMirroredSyncState.mockReturnValue({ ...IDLE, bgSyncStatus: 'syncing' });
    rerender(<Providers>ok</Providers>);
    mockUseMirroredSyncState.mockReturnValue({ ...IDLE, bgSyncStatus: 'idle' });
    rerender(<Providers>ok</Providers>);

    expect(externalSyncProps).toHaveLength(3);
    expect(externalSyncProps[1].requestSync).toBe(first);
    expect(externalSyncProps[2].requestSync).toBe(first);
  });

  it('asks the background for a cycle rather than running one here', () => {
    render(<Providers>ok</Providers>);

    (externalSyncProps[0].requestSync as () => void)();

    expect(mockSendMessage).toHaveBeenCalledWith({ type: 'KICK_SYNC' });
  });
});

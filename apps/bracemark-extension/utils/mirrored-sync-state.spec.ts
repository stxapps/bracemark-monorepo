import { type FakeBrowser, installFakeBrowser } from '../testing/fake-browser';
import {
  INITIAL_MIRRORED_SYNC_STATE,
  MIRRORED_SYNC_STATE_KEY,
  type MirroredSyncState,
  readMirroredSyncState,
  writeMirroredSyncState,
} from './mirrored-sync-state';

// The mirror is a BROADCAST between two JS contexts that share nothing else: the
// background worker writes it once per cycle, the popup and the options page read
// it (or subscribe) without waking the worker. Three things have to hold for that
// to work, and none of them is visible from either side alone —
//
//   - both sides agree on the key. `MIRRORED_SYNC_STATE_KEY` is exported, so a
//     rename can't drift, but a writer that wrapped the value differently from the
//     reader would still typecheck;
//   - a read BEFORE the first cycle answers with the initial state rather than
//     `undefined`, which is what lets the popup render a sync pill on a cold
//     profile instead of crashing on a missing field;
//   - the write lands in the `local` area, since that is the only area the popup's
//     subscription listens to (use-mirrored-sync-state.ts).

const READY: MirroredSyncState = {
  storeStatus: 'ready',
  bgSyncStatus: 'blocked-capacity',
  lastSyncAt: 1_700_000_000_000,
  lastError: null,
  blockedCount: 3,
};

let fake: FakeBrowser;

beforeEach(() => {
  fake = installFakeBrowser();
});

describe('the mirrored sync state', () => {
  it('reads as the initial state before any cycle has written one', async () => {
    await expect(readMirroredSyncState()).resolves.toEqual(INITIAL_MIRRORED_SYNC_STATE);
  });

  it('round-trips what the background wrote', async () => {
    await writeMirroredSyncState(READY);

    await expect(readMirroredSyncState()).resolves.toEqual(READY);
  });

  it('writes under the shared key so the popup subscription can find it', async () => {
    await writeMirroredSyncState(READY);

    expect(fake.storage.local.peek(MIRRORED_SYNC_STATE_KEY)).toEqual(READY);
  });

  it('announces the write on the local area', async () => {
    const seen: { changes: Record<string, unknown>; area: string }[] = [];
    fake.storage.onChanged.addListener((changes, area) => seen.push({ changes, area }));

    await writeMirroredSyncState(READY);

    expect(seen).toHaveLength(1);
    expect(seen[0].area).toBe('local');
    expect(seen[0].changes[MIRRORED_SYNC_STATE_KEY]).toEqual({
      oldValue: undefined,
      newValue: READY,
    });
  });
});

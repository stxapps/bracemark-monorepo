import {
  bgStatusForOutcome,
  emptySyncOutcome,
  formatSyncedAt,
  getSyncPhase,
  initialSyncProgressLabel,
  recordBlocked,
  SYNC_PHASE_LABELS,
  syncBlockedDetail,
  syncCycleProgressLabel,
} from './status';

// The two-field → one-phase collapse every status surface shares. Covered here
// rather than in each surface because the surfaces are supposed to be dumb: if
// this derivation is right, bracemark-web's Data card, the expo Data card and
// the extension popup pill all agree by construction.
describe('getSyncPhase', () => {
  it('lets the store gate outrank the background indicator', () => {
    // While the gate is still working there is no background cycle to report.
    expect(getSyncPhase('checking', 'error')).toBe('checking');
    expect(getSyncPhase('syncing-initial', 'blocked-capacity')).toBe('initial-syncing');
    expect(getSyncPhase('error', 'idle')).toBe('initial-error');
  });

  it('reports a blocked cycle as its own phase, not as an error', () => {
    // The distinction the whole state exists for: the cycle COMPLETED and the
    // local store is correct — only the storage ceiling stopped part of the
    // push. Collapsing this into 'cycle-error' would send the user hunting for a
    // network problem instead of telling them to free up space.
    expect(getSyncPhase('ready', 'blocked-capacity')).toBe('capacity-blocked');
    expect(SYNC_PHASE_LABELS['capacity-blocked']).not.toBe(SYNC_PHASE_LABELS['cycle-error']);
  });

  it('prefers a real failure over a quota block', () => {
    // Blocked is settled and only clears by freeing space; 'error' is retryable.
    // When a cycle somehow reports both, the retryable one is the actionable one.
    expect(getSyncPhase('ready', 'error')).toBe('cycle-error');
  });

  it('reports an in-flight cycle over any previous outcome', () => {
    expect(getSyncPhase('ready', 'syncing')).toBe('syncing');
  });

  it('settles to idle', () => {
    expect(getSyncPhase('ready', 'idle')).toBe('idle');
  });

  // An expired session pauses sync (docs/sessions.md). No cycle runs while
  // paused, so nothing a cycle once reported may outrank it — and it must never
  // read as a failure, because nothing failed and nothing is lost.
  it('reports a paused session over any cycle outcome, and not as an error', () => {
    expect(getSyncPhase('ready', 'paused')).toBe('paused');
    expect(SYNC_PHASE_LABELS.paused).not.toBe(SYNC_PHASE_LABELS['cycle-error']);
    expect(SYNC_PHASE_LABELS.paused).not.toBe(SYNC_PHASE_LABELS.idle);
  });

  it('still lets the store gate outrank a pause', () => {
    expect(getSyncPhase('error', 'paused')).toBe('initial-error');
  });
});

// The accumulator both engines write through. Its rules live in shared precisely
// so web-react and expo-react can't drift on them.
describe('recordBlocked', () => {
  it('starts clean', () => {
    expect(emptySyncOutcome()).toEqual({ blocked: false, blockedCount: 0 });
  });

  it('sums the refused ops across chunks', () => {
    const outcome = emptySyncOutcome();
    recordBlocked(outcome, 3);
    recordBlocked(outcome, 4);
    expect(outcome).toEqual({ blocked: true, blockedCount: 7 });
  });

  it('marks the cycle blocked even when a chunk refused nothing countable', () => {
    // `blocked` is its own field rather than `blockedCount > 0`, so a surface can
    // trust the state without trusting the number.
    const outcome = emptySyncOutcome();
    recordBlocked(outcome, 0);
    expect(outcome.blocked).toBe(true);
  });
});

// The other half of the accumulator's job: turning a finished cycle into the
// indicator both providers set. Owned in shared so web-react's SyncProvider and
// expo-react's cannot drift on what a blocked cycle settles to.
describe('bgStatusForOutcome', () => {
  it('settles a clean cycle to idle', () => {
    expect(bgStatusForOutcome(emptySyncOutcome())).toBe('idle');
  });

  it('settles a blocked cycle to blocked-capacity, not idle', () => {
    // The cycle COMPLETED, so the tempting reading is "it worked". But part of
    // the push was refused and will not retry itself into success — reporting
    // idle would leave the user's changes stranded with the UI saying
    // "Up to date", which is the one thing a sync indicator must never say
    // while something is unsynced.
    const outcome = emptySyncOutcome();
    recordBlocked(outcome, 3);
    expect(bgStatusForOutcome(outcome)).toBe('blocked-capacity');
  });

  it('reads `blocked`, not the count', () => {
    // The two fields are kept independently truthful on purpose, so a cycle that
    // hit the gate without a countable number still reports as blocked.
    const outcome = emptySyncOutcome();
    recordBlocked(outcome, 0);
    expect(bgStatusForOutcome(outcome)).toBe('blocked-capacity');
  });

  it('feeds getSyncPhase the phase the surfaces render', () => {
    const outcome = emptySyncOutcome();
    recordBlocked(outcome, 1);
    expect(getSyncPhase('ready', bgStatusForOutcome(outcome))).toBe('capacity-blocked');
  });
});

describe('syncBlockedDetail', () => {
  it('names the fix for a blocked cycle', () => {
    expect(syncBlockedDetail('capacity-blocked', 12)).toContain('Free up space');
  });

  it('counts the refused ops, singular and plural', () => {
    expect(syncBlockedDetail('capacity-blocked', 1)).toContain('1 change ');
    expect(syncBlockedDetail('capacity-blocked', 12)).toContain('12 changes ');
  });

  it('stays vague rather than saying "0 changes"', () => {
    expect(syncBlockedDetail('capacity-blocked', 0)).toContain('Some changes');
  });

  it('has nothing to say about the non-blocked phases', () => {
    expect(syncBlockedDetail('idle', 0)).toBeNull();
    expect(syncBlockedDetail('cycle-error', 3)).toBeNull();
  });
});

describe('initialSyncProgressLabel', () => {
  it('reads as a count, not a percentage', () => {
    // The whole point of the first-sync screen's number: "142 of 1,024" explains
    // the wait, where "14%" only measures it.
    expect(initialSyncProgressLabel({ done: 142, total: 1024 })).toBe('142 of 1,024 items');
  });

  it('says "items", never "links"', () => {
    // `total` counts every index blob — links AND tags/lists/pins/extractions/
    // settings — so it lands near twice the user's bookmark count. Calling those
    // links would be a number they can check and find wrong.
    expect(initialSyncProgressLabel({ done: 0, total: 8 })).not.toContain('link');
  });

  it('can reach its own total', () => {
    // The engine ticks in a `finally`, so skipped entries count too — the label
    // has to be able to render the completed state the gate holds up during its
    // minimum-visible floor.
    expect(initialSyncProgressLabel({ done: 8, total: 8 })).toBe('8 of 8 items');
  });
});

describe('syncCycleProgressLabel', () => {
  it('counts a push in changes — the unit of the "waiting to sync" line it stands in for', () => {
    expect(syncCycleProgressLabel({ step: 'upload', done: 340, total: 1000 })).toBe(
      '340 of 1,000 changes',
    );
    expect(syncCycleProgressLabel({ step: 'upload', done: 0, total: 1 })).toBe('0 of 1 change');
  });

  it('counts a pull in items, as the first sync does', () => {
    expect(syncCycleProgressLabel({ step: 'download', done: 12, total: 40 })).toBe(
      initialSyncProgressLabel({ done: 12, total: 40 }),
    );
  });
});

describe('formatSyncedAt', () => {
  const ago = (ms: number) => formatSyncedAt(Date.now() - ms);
  const MIN = 60_000;
  const HR = 60 * MIN;

  it('says "just now" inside the first minute', () => {
    // The common case by far — a sync fires on nearly every visit — so this is
    // the branch a user sees most.
    expect(ago(0)).toBe('just now');
    expect(ago(59 * 1000)).toBe('just now');
  });

  it('counts whole minutes up to an hour', () => {
    expect(ago(MIN)).toBe('1 min ago');
    expect(ago(45 * MIN)).toBe('45 min ago');
    expect(ago(59 * MIN)).toBe('59 min ago');
  });

  it('rolls to hours at exactly an hour, and to a date at a day', () => {
    // The boundaries, because an off-by-one here reads as "60 min ago" or
    // "24 hr ago" — both correct arithmetic and both obviously wrong on screen.
    expect(ago(HR)).toBe('1 hr ago');
    expect(ago(23 * HR)).toBe('23 hr ago');
    expect(ago(24 * HR)).not.toContain('hr ago');
  });

  it('falls back to a date past a day', () => {
    const ts = Date.now() - 5 * 24 * HR;
    expect(formatSyncedAt(ts)).toBe(new Date(ts).toLocaleDateString());
  });

  it('never reports a future timestamp as elapsed time', () => {
    // Clock skew between the device and the server's stamps is ordinary, and a
    // negative elapsed would otherwise render "-3 min ago".
    expect(ago(-5 * MIN)).toBe('just now');
  });
});

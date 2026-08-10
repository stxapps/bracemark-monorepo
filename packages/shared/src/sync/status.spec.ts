import {
  emptySyncOutcome,
  getSyncPhase,
  recordBlocked,
  SYNC_PHASE_LABELS,
  syncBlockedDetail,
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

// The unreadable record's state rules (unreadable.ts). Each case names a way the
// record can go wrong without anything failing: a path dropped that the server
// still holds (the orphaned-file sweep then deletes what it names, on every device),
// or a schedule that never comes due (the sweep stays off for good).

import {
  afterRecheck,
  forgetSettled,
  recheckBatch,
  recordSkips,
  UNREADABLE_RECHECK_DELAYS_MS,
  UNREADABLE_RECHECK_MAX,
  type UnreadableState,
} from './unreadable';

const NOW = 1_000_000;
const [FIRST, SECOND, LAST] = UNREADABLE_RECHECK_DELAYS_MS;
const EMPTY: UnreadableState = { paths: [], recheck: undefined };

describe('recordSkips', () => {
  it('adds new paths with their stamps and schedules the first recheck', () => {
    const next = recordSkips(EMPTY, [{ path: 'links/a.enc', updatedAt: 10 }], NOW);

    expect(next).toEqual({
      paths: ['links/a.enc'],
      recheck: { dueAt: NOW + FIRST, tries: 0, stamps: { 'links/a.enc': 10 } },
    });
  });

  it('restarts the backoff when a new path joins a record already backed off', () => {
    const held: UnreadableState = {
      paths: ['links/a.enc'],
      recheck: { dueAt: NOW + LAST, tries: 5, stamps: { 'links/a.enc': 10 } },
    };

    const next = recordSkips(held, [{ path: 'links/b.enc', updatedAt: 20 }], NOW);

    expect(next?.paths).toEqual(['links/a.enc', 'links/b.enc']);
    expect(next?.recheck).toMatchObject({ dueAt: NOW + FIRST, tries: 0 });
  });

  // The same path skipped again at a newer version: the stamp moves up (a healed
  // blob is stored at it), and the backoff does not restart, or a path rewritten
  // often would be fetched every hour for ever.
  it('keeps the newest stamp for a path skipped again, without restarting the backoff', () => {
    const held: UnreadableState = {
      paths: ['links/a.enc'],
      recheck: { dueAt: NOW + LAST, tries: 3, stamps: { 'links/a.enc': 10 } },
    };

    expect(recordSkips(held, [{ path: 'links/a.enc', updatedAt: 30 }], NOW)?.recheck).toEqual({
      dueAt: NOW + LAST,
      tries: 3,
      stamps: { 'links/a.enc': 30 },
    });
    expect(recordSkips(held, [{ path: 'links/a.enc', updatedAt: 5 }], NOW)).toBeNull();
  });
});

describe('forgetSettled', () => {
  it('drops settled paths and their stamps, and the schedule with the last one', () => {
    const held: UnreadableState = {
      paths: ['links/a.enc', 'links/b.enc'],
      recheck: { dueAt: NOW, tries: 1, stamps: { 'links/a.enc': 1, 'links/b.enc': 2 } },
    };

    const one = forgetSettled(held, ['links/a.enc']);
    expect(one).toEqual({
      paths: ['links/b.enc'],
      recheck: { dueAt: NOW, tries: 1, stamps: { 'links/b.enc': 2 } },
    });
    expect(one && forgetSettled(one, ['links/b.enc'])).toEqual({ paths: [], recheck: undefined });
  });

  it('changes nothing for paths not in the record', () => {
    expect(
      forgetSettled({ paths: ['links/a.enc'], recheck: undefined }, ['links/z.enc']),
    ).toBeNull();
  });
});

describe('recheckBatch', () => {
  const held = (dueAt?: number): UnreadableState => ({
    paths: ['links/a.enc'],
    recheck: dueAt === undefined ? undefined : { dueAt, tries: 0, stamps: {} },
  });

  it('is empty until the recheck is due, and the record from then on', () => {
    expect(recheckBatch(held(NOW + 1), NOW)).toEqual([]);
    expect(recheckBatch(held(NOW), NOW)).toEqual(['links/a.enc']);
  });

  // A record written before rechecks existed has no schedule. Treating that as
  // "never" would leave it stuck exactly as before.
  it('treats a record with no schedule as due', () => {
    expect(recheckBatch(held(), NOW)).toEqual(['links/a.enc']);
  });

  it(`fetches at most ${UNREADABLE_RECHECK_MAX} paths at a time`, () => {
    const paths = Array.from({ length: UNREADABLE_RECHECK_MAX + 5 }, (_, i) => `links/${i}.enc`);

    expect(recheckBatch({ paths, recheck: undefined }, NOW)).toEqual(
      paths.slice(0, UNREADABLE_RECHECK_MAX),
    );
  });
});

describe('afterRecheck', () => {
  it('drops what was gone, keeps what still fails, and backs off', () => {
    const held: UnreadableState = {
      paths: ['links/a.enc', 'links/b.enc'],
      recheck: { dueAt: NOW, tries: 0, stamps: { 'links/a.enc': 1, 'links/b.enc': 2 } },
    };

    const next = afterRecheck(held, ['links/a.enc', 'links/b.enc'], ['links/b.enc'], NOW);

    expect(next).toEqual({
      paths: ['links/a.enc'],
      recheck: { dueAt: NOW + SECOND, tries: 1, stamps: { 'links/a.enc': 1 } },
    });
  });

  it('settles at the last delay, however many times it fails', () => {
    let state: UnreadableState = {
      paths: ['links/a.enc'],
      recheck: { dueAt: NOW, tries: 0, stamps: {} },
    };
    for (let i = 0; i < UNREADABLE_RECHECK_DELAYS_MS.length + 3; i++) {
      state = afterRecheck(state, ['links/a.enc'], [], NOW);
    }

    expect(state.paths).toEqual(['links/a.enc']);
    expect(state.recheck?.dueAt).toBe(NOW + LAST);
  });

  // Large records are worked through: what was just tried goes behind what wasn't,
  // so the next batch reaches paths the last one could not.
  it('moves the paths it tried behind the ones it did not', () => {
    const held: UnreadableState = { paths: ['a', 'b', 'c'], recheck: undefined };

    expect(afterRecheck(held, ['a', 'b'], [], NOW).paths).toEqual(['c', 'a', 'b']);
  });

  it('leaves no schedule once nothing is left', () => {
    expect(afterRecheck({ paths: ['a'], recheck: undefined }, ['a'], ['a'], NOW)).toEqual({
      paths: [],
      recheck: undefined,
    });
  });
});

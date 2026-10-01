// Specs for the review-prompt bookkeeping. The contract is the sidebar-view store's: it
// must never be able to break the save it runs behind, and a shape it did not write reads
// as the empty state rather than reaching the caller's arithmetic.
//
// Real sqlite through the node:sqlite shim; the failure branches are reached by making
// `getDb` throw, the only way this platform's "storage unavailable" can happen.

import { sql } from 'drizzle-orm';

import * as db from './db';
import {
  countReviewPromptSave,
  readReviewPromptState,
  writeReviewPromptState,
} from './review-prompt-store';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));

// Seed a shape the writer would never produce — another build's, or a corrupted one.
function seedRawValue(value: unknown): void {
  db.getDb().run(
    sql`INSERT INTO review_prompt (id, value) VALUES ('singleton', ${JSON.stringify(value)})
        ON CONFLICT(id) DO UPDATE SET value = excluded.value`,
  );
}

const NEVER = { savesSinceAsk: 0, lastAskedAt: null, askCount: 0, openedStorePage: false };

beforeEach(() => {
  jest.restoreAllMocks();
  db.getDb().run(sql`DELETE FROM review_prompt`);
});

describe('readReviewPromptState', () => {
  it('is the never-asked state when nothing has been stored', () => {
    expect(readReviewPromptState()).toEqual(NEVER);
  });

  it('round-trips a written value', () => {
    const value = {
      savesSinceAsk: 3,
      lastAskedAt: 1_700_000_000_000,
      askCount: 2,
      openedStorePage: true,
    };
    writeReviewPromptState(value);

    expect(readReviewPromptState()).toEqual(value);
  });

  // A row written before the cap on asks existed.
  it('reads a row from before the ask cap as not yet counted and not opened', () => {
    seedRawValue({ savesSinceAsk: 4, lastAskedAt: 1_700_000_000_000 });

    expect(readReviewPromptState()).toEqual({
      ...NEVER,
      savesSinceAsk: 4,
      lastAskedAt: 1_700_000_000_000,
    });
  });

  // A NaN count would compare false against every threshold, so the prompt would never
  // fire again on this device — silently, since nothing reports a prompt that didn't show.
  it.each([
    ['a string count', { savesSinceAsk: '4', lastAskedAt: null }],
    ['a negative count', { savesSinceAsk: -1, lastAskedAt: null }],
    ['a non-object value', [1, 2]],
    ['an empty object', {}],
    ['a string askCount', { savesSinceAsk: 0, lastAskedAt: null, askCount: '2' }],
    ['a truthy non-boolean openedStorePage', { ...NEVER, openedStorePage: 'yes' }],
    // The field the window is SUBTRACTED from: `now - '2026-…'` is NaN, which is
    // neither rested nor in the future, so the window would never close.
    ['a date-string lastAskedAt', { ...NEVER, lastAskedAt: '2026-09-24T14:38:05.000Z' }],
  ])('reads %s as the never-asked state', (_label, value) => {
    seedRawValue(value);

    expect(readReviewPromptState()).toEqual(NEVER);
  });

  it('keeps a valid field beside a corrupt one', () => {
    seedRawValue({ savesSinceAsk: 'x', lastAskedAt: 1_700_000_000_000 });

    expect(readReviewPromptState()).toEqual({ ...NEVER, lastAskedAt: 1_700_000_000_000 });
  });

  it('is the never-asked state when storage throws', () => {
    jest.spyOn(db, 'getDb').mockImplementation(() => {
      throw new Error('sqlite unavailable');
    });

    expect(readReviewPromptState()).toEqual(NEVER);
  });
});

describe('writeReviewPromptState', () => {
  it('does not throw when storage throws', () => {
    jest.spyOn(db, 'getDb').mockImplementation(() => {
      throw new Error('sqlite unavailable');
    });

    expect(() => writeReviewPromptState({ ...NEVER, savesSinceAsk: 1 })).not.toThrow();
  });
});

describe('countReviewPromptSave', () => {
  it('adds one save and leaves the rest of the row alone', () => {
    writeReviewPromptState({
      savesSinceAsk: 2,
      lastAskedAt: 1_700_000_000_000,
      askCount: 1,
      openedStorePage: false,
    });

    countReviewPromptSave();

    expect(readReviewPromptState()).toEqual({
      savesSinceAsk: 3,
      lastAskedAt: 1_700_000_000_000,
      askCount: 1,
      openedStorePage: false,
    });
  });

  // It runs on the tail of a share that already landed.
  it('does not throw when storage throws', () => {
    jest.spyOn(db, 'getDb').mockImplementation(() => {
      throw new Error('sqlite unavailable');
    });

    expect(() => countReviewPromptSave()).not.toThrow();
  });
});

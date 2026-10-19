// Specs for the links-drawer collapse state. Same contract as web's localStorage sibling —
// it must never be able to break the drawer — reached differently: this is a JSON column in
// sqlite, so "unavailable storage" here means a throwing driver rather than an absent
// global, and the untrusted shape comes back through drizzle rather than through
// `JSON.parse`.
//
// The read is defensive about a shape it does not control: a non-array, or an array with a
// stray non-string, becomes a clean string list. A bad id costs nothing — it matches no
// section and stays inert — whereas a throw takes the whole drawer down during a render,
// and a `string[]` that actually holds a number reaches the consumers' `Set` lookups as a
// silent never-match.
//
// Real sqlite through the node:sqlite shim; the failure branches are reached by making
// `getDb` throw, which is the only way this platform's "storage unavailable" can happen.

import { sql } from 'drizzle-orm';

import * as db from './db';
import {
  readSidebarCollapsedIds,
  readSidebarRailCollapsed,
  writeSidebarCollapsedIds,
  writeSidebarRailCollapsed,
} from './sidebar-view-store';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));

// Seed the row with a shape the module didn't write — a value from another build, or a
// corrupted one. Goes through raw SQL because the writer would never produce it.
function seedRawValue(value: unknown): void {
  db.getDb().run(
    sql`INSERT INTO sidebar_view (id, value) VALUES ('singleton', ${JSON.stringify(value)})
        ON CONFLICT(id) DO UPDATE SET value = excluded.value`,
  );
}

beforeEach(() => {
  jest.restoreAllMocks();
  db.getDb().run(sql`DELETE FROM sidebar_view`);
});

describe('readSidebarCollapsedIds', () => {
  // "Everything expanded" is the safe default for every failure below — the user sees their
  // nav, just not collapsed the way they left it.
  it('is empty when nothing has been stored', () => {
    expect(readSidebarCollapsedIds()).toEqual([]);
  });

  it('round-trips a written set', () => {
    writeSidebarCollapsedIds(['lists', 'li_1']);

    expect(readSidebarCollapsedIds()).toEqual(['lists', 'li_1']);
  });

  // Valid JSON of the wrong shape — the case an unguarded read would hand straight to a
  // consumer expecting to iterate it, during a render of the drawer.
  it('is empty for a stored value that is not an array', () => {
    seedRawValue({ collapsedIds: { lists: true } });

    expect(readSidebarCollapsedIds()).toEqual([]);
  });

  it('is empty for a row with no collapsedIds at all', () => {
    seedRawValue({});

    expect(readSidebarCollapsedIds()).toEqual([]);
  });

  // The narrowing that makes the declared `string[]` honest: a stray non-string is dropped,
  // not passed through to fail a `Set<string>` lookup forever.
  it('drops non-string entries rather than passing them through', () => {
    seedRawValue({ collapsedIds: ['lists', 42, null, 'tags'] });

    expect(readSidebarCollapsedIds()).toEqual(['lists', 'tags']);
  });

  // A read that throws happens during a render of the nav. Starting everything expanded is
  // a cosmetic loss; a thrown error is the drawer gone.
  it('is empty when the store itself is unreadable', () => {
    jest.spyOn(db, 'getDb').mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(readSidebarCollapsedIds()).toEqual([]);
  });
});

describe('writeSidebarCollapsedIds', () => {
  // The hook passes the WHOLE set each toggle, so a write replaces rather than merges —
  // otherwise nothing could ever be expanded again.
  it('replaces the stored set rather than merging into it', () => {
    writeSidebarCollapsedIds(['lists', 'tags']);
    writeSidebarCollapsedIds(['tags']);

    expect(readSidebarCollapsedIds()).toEqual(['tags']);
  });

  // The in-memory set still drives this session's UI — a failed persist must never surface
  // at a collapse toggle.
  it('is a no-op when the store is unwritable', () => {
    jest.spyOn(db, 'getDb').mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(() => writeSidebarCollapsedIds(['lists'])).not.toThrow();
  });
});

describe('the docked rail flag', () => {
  // Shown is the default for every failure, for the reason the module gives.
  it('reads as shown when nothing has been stored', () => {
    expect(readSidebarRailCollapsed()).toBe(false);
  });

  it('round-trips both values', () => {
    writeSidebarRailCollapsed(true);
    expect(readSidebarRailCollapsed()).toBe(true);

    writeSidebarRailCollapsed(false);
    expect(readSidebarRailCollapsed()).toBe(false);
  });

  // A row written before the field existed, and a value of the wrong type: neither may
  // put the rail away.
  it('reads as shown for a row without the field or with a non-boolean', () => {
    seedRawValue({ collapsedIds: ['lists'] });
    expect(readSidebarRailCollapsed()).toBe(false);

    seedRawValue({ collapsedIds: [], railCollapsed: 'yes' });
    expect(readSidebarRailCollapsed()).toBe(false);
  });

  // One row holds both halves, so each writer has to carry the other through.
  it('keeps the collapse ids when the flag is written, and the flag when the ids are', () => {
    writeSidebarCollapsedIds(['lists']);
    writeSidebarRailCollapsed(true);
    expect(readSidebarCollapsedIds()).toEqual(['lists']);

    writeSidebarCollapsedIds(['tags']);
    expect(readSidebarRailCollapsed()).toBe(true);
    expect(readSidebarCollapsedIds()).toEqual(['tags']);
  });

  it('degrades to shown, and never throws, when the store is unavailable', () => {
    jest.spyOn(db, 'getDb').mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(readSidebarRailCollapsed()).toBe(false);
    expect(() => writeSidebarRailCollapsed(true)).not.toThrow();
  });
});

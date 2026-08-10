// A Node stand-in for expo-sqlite's `openDatabaseSync`, so the store specs can
// drive the REAL drizzle expo driver (`drizzle-orm/expo-sqlite`) against an
// in-memory database — `getDb()` runs unmocked, PRAGMA and DDL included, and the
// SQL under test goes through the same session code that runs on device.
//
// Why not better-sqlite3 (the obvious alternative): it would mean swapping in
// drizzle's OTHER driver, so the spec would exercise a code path the app never
// takes — and, more sharply, it hands BLOBs back as Node `Buffer` where
// expo-sqlite hands back `Uint8Array`. db.ts types the `data` column as
// `Uint8Array` (Hermes has no Buffer) with no `fromDriver` conversion, so under
// better-sqlite3 that annotation is a lie the specs can't catch: `Buffer`
// subclasses `Uint8Array`, so structural matchers pass. node:sqlite returns real
// `Uint8Array`, matching the device. It also drops a native compile step from the
// toolchain, since node:sqlite is built in.
//
// The driver's client contract is small — this implements only what
// `drizzle-orm/expo-sqlite`'s session actually calls (`prepareSync`, and on the
// statement `executeSync` / `executeForRawResultSync`), plus the `execSync` that
// db.ts uses for the PRAGMA and the DDL. Transactions need nothing extra:
// drizzle drives `begin`/`commit`/`rollback` through the same prepare path.
//
// NOT emulated: `enableChangeListener`. drizzle's `useLiveQuery` subscribes to
// expo-sqlite's change events, so reactivity stays out of scope here — these
// specs are about the SQL, not the subscription.

import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

function wrapStatement(stmt: StatementSync) {
  return {
    // expo-sqlite returns ONE result object that answers both "how many rows
    // changed" and "give me the rows"; node:sqlite makes you choose `run()` vs
    // `all()` up front. So execution is deferred to whichever face the caller
    // touches — and the `run()` result is memoized, because drizzle destructures
    // `{ changes, lastInsertRowId }` and two independent getters would execute
    // the statement (an INSERT!) twice. Keep that memo if you touch this.
    executeSync(params: SQLInputValue[] = []) {
      let ran: ReturnType<StatementSync['run']> | undefined;
      const run = (): NonNullable<typeof ran> => (ran ??= stmt.run(...params));
      return {
        get changes() {
          return Number(run().changes);
        },
        get lastInsertRowId() {
          return Number(run().lastInsertRowid);
        },
        getAllSync: () => stmt.all(...params),
        getFirstSync: () => stmt.get(...params),
      };
    },
    // drizzle's `.values()` path wants positional rows rather than objects.
    // Toggled per call and restored, since the flag lives on the statement and
    // these are prepared once and reused.
    executeForRawResultSync(params: SQLInputValue[] = []) {
      return {
        getAllSync: () => {
          stmt.setReturnArrays(true);
          try {
            return stmt.all(...params);
          } finally {
            stmt.setReturnArrays(false);
          }
        },
      };
    },
  };
}

// `name` and the options are accepted and ignored: every call gets its own
// private in-memory database, which is what a spec wants.
export function openDatabaseSync(
  _name: string,
  _options?: { enableChangeListener?: boolean },
): {
  execSync: (sql: string) => void;
  prepareSync: (sql: string) => ReturnType<typeof wrapStatement>;
  closeSync: () => void;
} {
  const db = new DatabaseSync(':memory:');
  return {
    execSync: (sql: string) => db.exec(sql),
    prepareSync: (sql: string) => wrapStatement(db.prepare(sql)),
    closeSync: () => db.close(),
  };
}

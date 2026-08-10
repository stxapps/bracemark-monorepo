import { DurableObject } from 'cloudflare:workers';

import {
  type CommitResult,
  MAX_LIST_LIMIT,
  type OpEntry,
  type OpsListResponse,
} from '@stxapps/shared';

import type { Bindings } from '../lib/env';
import { fileSizesRepo, type FileUsage } from './repositories/file-sizes';
import { type OpKind, opLogsRepo } from './repositories/op-logs';

// `FileUsage` is the DO's public usage contract — re-exported here so consumers
// (lib/quota.ts) depend on the DO boundary, not its private repository layer. It
// stays identical to the repo shape because `usage()` returns it verbatim; if the
// RPC ever needs to trim a repo-internal field (the way listOps drops op-log
// `seq`), split it into a distinct type here at that point.
export type { FileUsage };

// One mutation ready to record — what the service hands the DO after resolving
// each op against R2. `updatedAt`/`size` are sourced per kind in services/sync.ts:
// a put carries R2's `LastModified` + reported size; a delete carries the worker's
// commit clock and size 0 (the freed size is read from the quota map, not here).
export type CommitEntry = {
  op: OpKind;
  path: string;
  updatedAt: number;
  size: number;
};

// Per-user data store. One Durable Object instance per user (addressed by
// idFromName(userId) — see userDataStub below), giving each user an isolated,
// strictly-serialized SQLite database with no shared size ceiling. Because the DO
// is single-threaded it is the natural place to mint the op log's monotonic seq,
// and a per-user alarm() can drive op-log compaction later.
//
// MIGRATIONS ARE IN CODE. A DO's SQLite is NOT a D1 database — `wrangler d1
// migrations apply` does not touch it. We track the applied version in a tiny
// `schema_version` table (NOT `PRAGMA user_version`: workerd's DO SQLite
// authorizer rejects that PRAGMA with SQLITE_AUTH) and apply any pending
// statements on construction, before the instance serves a request
// (blockConcurrencyWhile). The schema snapshot in do/README.md mirrors this for
// at-a-glance reference only and is not applied by any tool. See do/README.md.

// Ordered schema versions: entry i upgrades schema_version i -> i+1. APPEND ONLY
// — never edit a shipped entry (DOs already past it won't re-run it). Each entry
// is a list of single statements (SqlStorage.exec runs one statement per call).
const MIGRATIONS: string[][] = [
  // 0 -> 1: initial append-only op log. AUTOINCREMENT (not bare rowid) so seq is
  // strictly increasing and never reused even after compaction deletes old rows.
  // the keyset cursor index + the durable per-path size map. The op-list
  // pull is a keyset scan ordered by (updated_at, path) (op-logs.ts listSince), so
  // index that exact tuple. `file_sizes` is the quota's source of truth — set on
  // every committed put, read-and-subtracted on delete (file-sizes.ts) — kept
  // separate from the compactable op log so it never undercounts.
  [
    `CREATE TABLE IF NOT EXISTS op_logs (
       seq        INTEGER PRIMARY KEY AUTOINCREMENT,
       op         TEXT NOT NULL,
       path       TEXT NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_op_logs_path ON op_logs(path)`,
    `CREATE INDEX IF NOT EXISTS idx_op_logs_cursor ON op_logs(updated_at, path)`,
    `CREATE TABLE IF NOT EXISTS file_sizes (
       path TEXT PRIMARY KEY,
       size INTEGER NOT NULL
     )`,
  ],
];

function migrate(sql: SqlStorage): void {
  // Schema version lives in a tiny dedicated table, NOT `PRAGMA user_version`:
  // workerd's Durable Object SQLite authorizer rejects `PRAGMA user_version`
  // (SQLITE_AUTH), so the PRAGMA approach silently bricks the DO on construction.
  // A one-row table is plain DML the authorizer allows and stays transactional
  // with the migration statements.
  sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const row = sql.exec(`SELECT version FROM schema_version LIMIT 1`).toArray()[0] as
    { version: number } | undefined;
  const current = row ? Number(row.version) : 0;

  for (let v = current; v < MIGRATIONS.length; v++) {
    for (const stmt of MIGRATIONS[v]) sql.exec(stmt);
  }
  if (current < MIGRATIONS.length) {
    sql.exec(`DELETE FROM schema_version`);
    sql.exec(`INSERT INTO schema_version (version) VALUES (?)`, MIGRATIONS.length);
  }
}

export class UserDataDO extends DurableObject<Bindings> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Finish migrating before the instance handles any RPC — blockConcurrencyWhile
    // holds incoming calls until this resolves.
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.sql);
    });
  }

  // RPC: incremental pull (GET /v1/ops/list). Keyset scan over the compound cursor
  // (updatedAt, path) plus the retained-range bounds the client routes on. Asks for
  // limit+1 to detect `hasMore` without a second COUNT, then trims to `limit`. The
  // wire shape drops the internal `seq` (op-logs.ts keeps it for ordering only).
  listOps(since: number | null, sincePath: string | null, limit = MAX_LIST_LIMIT): OpsListResponse {
    const repo = opLogsRepo(this.sql);
    const rows = repo.listSince(since, sincePath, limit + 1);
    const hasMore = rows.length > limit;
    const ops: OpEntry[] = rows
      .slice(0, limit)
      .map((r) => ({ op: r.op, path: r.path, updatedAt: r.updatedAt }));
    const { oldestUpdatedAt, newestUpdatedAt } = repo.bounds();
    return { ops, oldestUpdatedAt, newestUpdatedAt, hasMore };
  }

  // RPC: record committed file mutations (POST /v1/ops/commit), batched. Pure
  // writes against this DO's own SQLite — the R2 side (each put's existence check
  // + reading R2's `LastModified`/size, and dropping puts with no object) is done
  // by the caller in services/sync.ts, which passes only the survivors in. The log
  // must never point at an object that isn't in R2 (op-without-object 404s every
  // client that pulls it; an object with no op is harmless and healed by the
  // fallback R2 listing), so the service HEADs R2, never hands a put without an
  // object here, and reports those in the response's `failed` (not this RPC, which
  // only ever sees survivors and so returns only `results`). See
  // docs/local-first-sync.md.
  //
  // Each entry's `path` is the wire-relative path (the DO is the user's whole
  // scope, so rows carry no userId). `updatedAt` is the op log's cursor clock,
  // sourced per kind by the service:
  //  - put:    R2's authoritative `LastModified`, with `size` its reported size,
  //            recorded in the quota map.
  //  - delete: the worker's commit clock (no object survives to HEAD), and the
  //            path's recorded size is freed from the quota map (`size` ignored).
  // Mixing the two clocks is safe because paths are immutable random ids — a path
  // is only ever put…put…delete, so a put and a delete on it never have to be
  // ordered against each other. Running the whole batch in one RPC keeps it to a
  // single round trip to this serialized SQLite. Returns each entry's recorded
  // `updatedAt`, in input order, for the client to store and advance its cursor to.
  //
  // THE CLAMP: an entry whose `updatedAt` is not ahead of every row already in the
  // log is recorded at `MAX(updated_at) + 1` instead. A put's timestamp is minted at
  // PUT time (R2's `LastModified`) but only becomes visible here at commit time, and
  // the two can be minutes apart (the rest of a chunk's uploads, retry backoff) — so
  // without the clamp a slow committer could append an op BEHIND a cursor some other
  // client already advanced past (its own commits, or a faster committer's, stamped
  // later), and that client's keyset pull would skip the op forever: silent
  // cross-device staleness with no error and nothing to retry. Clamping makes every
  // append strictly newer than any cursor this log could have issued, which is what
  // the doc's "anything that lands mid-sync carries a later `updatedAt`" promise
  // actually requires (docs/local-first-sync.md — the three flows). Within one batch
  // the shared floor is fine: the batch commits atomically under this serialized DO,
  // so a puller sees all of it or none, and the path tiebreak orders its ties.
  // Consequences are benign by construction: per-path order is preserved (the prior
  // op for a path is already in the log, so the clamp only ever lifts the new one
  // above it), and a stamp nudged past R2's real `LastModified` at most costs a
  // fallback-listing comparison one redundant, idempotent re-download.
  commitOps(entries: CommitEntry[]): { results: CommitResult[] } {
    const sizes = fileSizesRepo(this.sql);
    const ops = opLogsRepo(this.sql);
    const { newestUpdatedAt } = ops.bounds();
    const floor = newestUpdatedAt === null ? 0 : newestUpdatedAt + 1;
    const results = entries.map(({ op, path, updatedAt, size }) => {
      const stamped = Math.max(updatedAt, floor);
      if (op === 'put') sizes.set(path, size);
      else sizes.remove(path);

      ops.append(op, path, stamped);
      return { path, updatedAt: stamped };
    });
    return { results };
  }

  // RPC: current storage usage for this user, read by the `files/sign` put-quota
  // check. Sourced from the durable size map, never the compactable op log. The
  // only DO call on the sign path — the companion existence lookup went away
  // with the link cap (lib/quota.ts).
  usage(): FileUsage {
    return fileSizesRepo(this.sql).usage();
  }

  // RPC: delete-all-data — clear the op log AND the quota map in one serialized
  // call (POST /v1/data/delete-all; also the first step of account deletion).
  // This runs BEFORE the R2 objects are deleted, which is the op-without-object
  // invariant read in the delete direction: wiping the log first means a crash
  // mid-wipe leaves only objects-without-ops (invisible to incremental pull,
  // healed/still-listed by the R2 fallback), never surviving put-ops pointing at
  // 404s for every puller. The emptied log is ALSO the multi-device signal: a
  // returning client's cursor against null bounds routes it into the download-
  // authoritative fallback, which reconciles it against the empty namespace.
  // Clearing the size map here (not after the R2 loop) accepts a transient
  // undercount if that loop dies mid-way — the visible endpoint failure has the
  // user retry, and the retry re-zeroes reality; the opposite order would leak
  // recorded sizes for objects that no longer exist (paths are never reused, so
  // no later commit would ever free them).
  wipeAll(): void {
    opLogsRepo(this.sql).clear();
    fileSizesRepo(this.sql).clear();
  }
}

// Resolve the caller's per-user DO stub. Deterministic: the same userId always
// maps to the same instance, so there is NO shard-assignment table to maintain
// (the win over hand-sharded D1). The DO is created lazily on first access — no
// provisioning step at account creation.
export function userDataStub(env: Bindings, userId: string): DurableObjectStub<UserDataDO> {
  return env.USER_DATA.get(env.USER_DATA.idFromName(userId));
}

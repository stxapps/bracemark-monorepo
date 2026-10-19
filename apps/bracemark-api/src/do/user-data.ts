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

// Where the op log stood at one moment: its `generation` (bumped by every wipe)
// and its `position` (the newest seq it held). `files/sign` reads one for a
// batch of PUT tokens (putGate), each token carries it into the upload receipt
// its PUT answers with (r2/upload-receipt.ts), and the commit asks the log
// whether the object could have been removed since (commitOps, THE FENCE).
export type LogFence = { generation: number; position: number };

// One mutation ready to record — what the service hands the DO after resolving
// each op against R2. `updatedAt`/`size` are sourced per kind in services/sync.ts:
// a put carries R2's `LastModified` + reported size; a delete carries the worker's
// commit clock and size 0 (the freed size is read from the quota map, not here).
// A put whose facts came from an upload receipt rather than from R2 carries the
// receipt's `fence` too, and is recorded only if the log can vouch for it.
export type CommitEntry = {
  op: OpKind;
  path: string;
  updatedAt: number;
  size: number;
  fence?: LogFence;
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
// (blockConcurrencyWhile). The MIGRATIONS array below is the SOLE source of truth
// for this schema — a DO has no create-from-snapshot path (it is only ever built
// by replaying the array), so there is deliberately no snapshot to drift out of
// lockstep with, in do/README.md or anywhere else. See do/README.md.

// Ordered schema versions: entry i upgrades schema_version i -> i+1. APPEND ONLY
// — never edit a shipped entry (DOs already past it won't re-run it). Each entry
// is a list of single statements (SqlStorage.exec runs one statement per call).
const MIGRATIONS: string[][] = [
  // 0 -> 1: initial append-only op log. AUTOINCREMENT (not bare rowid) so seq is
  // strictly increasing and never reused even after compaction deletes old rows.
  // Then the keyset cursor index + the durable per-path size map. The op-list
  // pull is a keyset scan ordered by (updated_at, path) (op-logs.ts listSince), so
  // index that exact tuple. `file_sizes` is the quota's source of truth — set on
  // every committed put, read-and-subtracted on delete (file-sizes.ts) — kept
  // separate from the compactable op log so it never undercounts.
  //
  // `idx_op_logs_cursor` is the ONLY index op_logs carries, deliberately. There is
  // no index on `path` alone: nothing reads the log by path (op-logs.ts has only
  // listSince/bounds/append/clear), and an index here is paid on `append` — the
  // hottest write in the system, once per committed put and delete. Compaction
  // (dedupe-by-path, not built yet) is the one plausible reader; add it in a new
  // MIGRATIONS entry then, alongside the code that uses it. (The receipt fence's
  // `deletesAfter` reads by seq, a primary-key range, and needs no such index.)
  [
    `CREATE TABLE IF NOT EXISTS op_logs (
       seq        INTEGER PRIMARY KEY AUTOINCREMENT,
       op         TEXT NOT NULL,
       path       TEXT NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_op_logs_cursor ON op_logs(updated_at, path)`,
    `CREATE TABLE IF NOT EXISTS file_sizes (
       path TEXT PRIMARY KEY,
       size INTEGER NOT NULL
     )`,
  ],
  // 1 -> 2: the log's generation, for the upload-receipt fence (commitOps). One
  // row, written by the first wipe; absent reads as generation 0, so a DO that
  // has never been wiped needs nothing backfilled.
  [`CREATE TABLE IF NOT EXISTS log_generation (generation INTEGER NOT NULL)`],
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
  // fallback R2 listing), so the service checks R2 (r2/user-files.ts statMany) —
  // or takes the facts from the put's upload receipt, which THE FENCE below
  // checks against this log — never hands a put without an object here, and
  // reports those in the response's `failed` (not this RPC, which only ever sees
  // survivors). See docs/local-first-sync.md.
  //
  // Each entry's `path` is the wire-relative path (the DO is the user's whole
  // scope, so rows carry no userId). `updatedAt` is the op log's cursor clock,
  // sourced per kind by the service:
  //  - put:    R2's authoritative `LastModified`, with `size` its reported size,
  //            recorded in the quota map.
  //  - delete: the worker's commit clock (no object survives to check), and the
  //            path's recorded size is freed from the quota map (`size` ignored).
  // Mixing the two clocks is safe because of THE CLAMP below, not because a deleted
  // path is never put again: `pins/` and `extractions/` are keyed by their link's
  // id, so unpin-then-pin and a re-extraction do put a path a delete just vacated.
  // The clamp records every entry above everything already in the log, so a path's
  // ops are ordered by commit, never by comparing the worker's clock against R2's
  // (docs/local-first-sync.md — the three flows). Running the whole batch in one
  // RPC keeps it to a single round trip to this serialized SQLite. Returns each
  // entry's recorded `updatedAt`, in input order, for the client to store on the
  // record it names — and NOT to move its cursor to: a commit's stamp says where
  // that op sits in the log, not that the committer has read everything below it
  // (docs/local-first-sync.md — the cursor is a claim).
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
  //
  // STRICTLY newer is load-bearing twice over, which is why the floor is `+ 1` and
  // an entry arriving at exactly the newest stamp is lifted too. A client that
  // lists R2 (first sync, fallback) reads `newestUpdatedAt` BEFORE the listing and
  // ends on it as its cursor: everything at or below it was committed before that
  // read and is in the listing, and nothing appended afterwards can tie with it or
  // sit under it (listOps' bounds; the clients' logWatermark).
  //
  // Consequences are benign by construction: per-path order is preserved (the prior
  // op for a path is already in the log, so the clamp only ever lifts the new one
  // above it), and a stamp nudged past R2's real `LastModified` costs a client that
  // stored the object from a LISTING, at R2's stamp, one redundant, idempotent
  // re-download when it later meets the lifted op. The committer itself stores the
  // lifted stamp, so a fallback listing — which downloads only what is stamped
  // newer than the local copy — just passes over the path.
  //
  // THE FENCE: an entry carrying a `fence` came from an upload receipt, which
  // proves its object LANDED and not that it is still there — and the log must
  // never point at an object that is not (above). Nothing removes a user's object
  // but a committed delete of its path (R2 first, then its op here) or a wipe
  // (wipeAll here first, then R2). So the receipted put is recorded only if the
  // log is in the receipt's generation AND holds no delete of its path appended
  // after the receipt's position. Any later delete, whichever side of the PUT its
  // R2 call fell on, was appended after the token was signed and so sits above
  // the position; a delete still between its R2 call and its op here will append
  // after this entry and leave the path's last op a delete, as the object is.
  //
  // A stale entry is NOT refused. The batch is recorded ATOMICALLY OR NOT AT ALL —
  // nothing is written, and the stale paths come back in `stale` — and the
  // service re-checks those puts against R2 and commits the batch again
  // (services/sync.ts commitOps). All-or-nothing because a batch can order its
  // paths (the share sheet's commits referenced-before-referencing), and a
  // partial write would let a puller see a later path without an earlier one.
  // Stale is rare: it takes a delete of the same path from another device, or a
  // wipe, landing inside one push.
  //
  // The fence can only see what the log still holds. Compaction, when it lands,
  // must keep every op younger than a receipt can be (r2/upload-receipt.ts,
  // RECEIPT_TTL_SECONDS); a delete older than that predates every receipt's
  // token, and with it every PUT a live receipt describes.
  commitOps(entries: CommitEntry[]): { results: CommitResult[]; stale: string[] } {
    const sizes = fileSizesRepo(this.sql);
    const ops = opLogsRepo(this.sql);
    const stale = staleReceipts(ops, entries);
    if (stale.length > 0) return { results: [], stale };

    const { newestUpdatedAt } = ops.bounds();
    const floor = newestUpdatedAt === null ? 0 : newestUpdatedAt + 1;
    const results = entries.map(({ op, path, updatedAt, size }) => {
      const stamped = Math.max(updatedAt, floor);
      if (op === 'put') sizes.set(path, size);
      else sizes.remove(path);

      ops.append(op, path, stamped);
      return { path, updatedAt: stamped };
    });
    return { results, stale: [] };
  }

  // RPC: current storage usage for this user. Sourced from the durable size map,
  // never the compactable op log.
  usage(): FileUsage {
    return fileSizesRepo(this.sql).usage();
  }

  // RPC: what a `files/sign` put reads — the usage its quota check compares
  // (lib/quota.ts), and the log's fence for the PUT tokens it mints
  // (r2/blob-token.ts). One RPC for both, so a sign still makes ONE call to this
  // DO: the only DO call on the sign path (the companion existence lookup went
  // away with the link cap, lib/quota.ts).
  putGate(): { usage: FileUsage; fence: LogFence } {
    const ops = opLogsRepo(this.sql);
    return {
      usage: fileSizesRepo(this.sql).usage(),
      fence: { generation: ops.generation(), position: ops.newestSeq() },
    };
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
  // recorded sizes for objects that no longer exist (a path is all but never
  // written again — only `pins/` and `extractions/` reuse one, by link id — so no
  // later commit would free them).
  //
  // It also starts a new GENERATION of the log: the wipe appends no delete, so
  // without it an upload receipt minted before the wipe would find nothing in the
  // emptied log to stop it, and its put would be recorded over an object the R2
  // half is about to remove (commitOps, THE FENCE).
  wipeAll(): void {
    const ops = opLogsRepo(this.sql);
    ops.clear();
    ops.bumpGeneration();
    fileSizesRepo(this.sql).clear();
  }
}

// The paths of the receipted entries the log cannot vouch for — commitOps' fence.
// Empty when no entry carries a fence, which is every commit from a client
// without receipts, at the cost of nothing.
function staleReceipts(ops: ReturnType<typeof opLogsRepo>, entries: CommitEntry[]): string[] {
  const fenced = entries.filter((e): e is CommitEntry & { fence: LogFence } => !!e.fence);
  if (fenced.length === 0) return [];

  const generation = ops.generation();
  const current = fenced.filter((e) => e.fence.generation === generation);
  const lastDelete = new Map<string, number>();
  if (current.length > 0) {
    const from = current.reduce((min, e) => Math.min(min, e.fence.position), Infinity);
    for (const { path, seq } of ops.deletesAfter(from)) {
      lastDelete.set(path, Math.max(lastDelete.get(path) ?? 0, seq));
    }
  }
  return fenced
    .filter(
      (e) => e.fence.generation !== generation || (lastDelete.get(e.path) ?? 0) > e.fence.position,
    )
    .map((e) => e.path);
}

// Resolve the caller's per-user DO stub. Deterministic: the same userId always
// maps to the same instance, so there is NO shard-assignment table to maintain
// (the win over hand-sharded D1). The DO is created lazily on first access — no
// provisioning step at account creation.
export function userDataStub(env: Bindings, userId: string): DurableObjectStub<UserDataDO> {
  return env.USER_DATA.get(env.USER_DATA.idFromName(userId));
}

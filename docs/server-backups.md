## server backups & replication

How the server-side state is backed up, replicated and restored. Not to be
confused with the user-facing **bracemark backup** archive (export ⇄ import),
which is [data-lifecycle.md](./data-lifecycle.md). Why the Tier-0 set is Tier-0,
and why it lives in D1, is [account.md](./account.md#storage-durability--the-most-critical-state-in-the-system);
what R2 and the Durable Object hold is [local-first-sync.md](./local-first-sync.md).

### what each store needs

| store                                   | holds                                        | stakes                                                 | protection                                   |
| --------------------------------------- | -------------------------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| `DIRECTORY_DB` (D1)                     | `usernames`, `purchases`, `paddle_checkouts` | **Tier-0** — the only path from a handle to an account | Time Travel + encrypted off-Cloudflare dumps |
| each account shard (`ACCOUNTS_DB_1`, …) | `users`, `account_keys` (wrapped DEKs)       | **Tier-0** — lose it and the account is dead           | Time Travel + encrypted off-Cloudflare dumps |
| `SESSIONS_DB` (D1)                      | `sessions`                                   | disposable — loss signs everyone out                   | none                                         |
| `USER_FILES` (R2)                       | every user's encrypted files                 | **source of truth** for bookmark data                  | off-Cloudflare mirror with dated history     |
| `USER_DATA` (Durable Object, per user)  | op log, `file_sizes` quota map               | op log disposable; quota map derivable from R2         | built-in 30-day PITR only                    |

### backups & replication

- **D1 Tier-0 set — `DIRECTORY_DB` + every account shard:** Time Travel is always
  on and free — any point in the **last 30 days** is restorable
  (`wrangler d1 time-travel restore`). Note these are **separate databases with
  separate timelines**, so a point-in-time restore that must stay consistent
  across the directory and a shard is a per-db operation — pick a quiet point and
  restore each. Time Travel lives inside the Cloudflare account, so for a copy
  that a platform-level account problem can't take with it, a scheduled export
  of **each** of these dbs goes **off Cloudflare** (_the off-Cloudflare copy_,
  below). That copy is for independence, not for longer history: it keeps the
  same 30 days (_Retention is a public promise_). (`SESSIONS_DB` is not Tier-0,
  so it's skipped.)
- **R2 (bulk ciphertext):** R2 is durable but **not versioned**, and it is the
  **source of truth** for bookmark data
  ([local-first-sync.md](./local-first-sync.md#source-of-truth-r2-is-truth-the-op-log-is-an-accelerator)).
  A client's local copy is a replica only for as long as that client exists: a
  new device's first sync, and every fallback full sync, is download-authoritative
  from R2, so a user whose only device is gone has nothing but R2. It is less
  catastrophic than the Tier-0 set — ciphertext without a DEK is useless, but a
  DEK without ciphertext is an empty account, not a dead one — yet it is not a
  second-class copy. It needs a copy that keeps **history**, not a plain mirror.
  Content files are overwritten in place (`local-first-sync.md`, _upload metadata
  LAST_), so a mirror copies a bad write over the good one, and mirroring deletes
  mirrors the accident. A second R2 bucket also sits in the same account. Today:
  an off-Cloudflare mirror with dated history. Later: replication to a versioned
  bucket at another provider (_later_).
- **The per-user Durable Object:** nothing beyond the built-in 30-day PITR of
  SQLite-backed DOs, deliberately. The op log is a disposable accelerator —
  losing it only routes clients into the fallback full sync against R2. The
  `file_sizes` quota map is durable, but it is `path → size` for objects that
  are in R2, so an R2 listing reproduces it (no rebuild path exists in code yet;
  write it if a DO is ever lost, rather than backing the map up).
- **Test restores.** A backup you have never restored is not a backup —
  periodically restore D1 to a scratch DB and confirm a sample of wrapped DEKs
  still unwrap (_restore drill_, below).

### R2 hygiene

Keep the bookmark bucket free of any **lifecycle rule** that could silently expire
a user's server copy — nothing errors when one fires; the objects are simply gone,
and with R2 as the source of truth there is no copy to converge back from. Route
deletes through a separate admin path, not the hot request path.

### the off-Cloudflare copy

Today it is a scheduled pull to storage we hold ourselves, not a provider's —
which is why it is not on the privacy page's provider list, and why /privacy,
_Where your data is_, says so. It needs no production code. Its runbook — where
it runs, its schedule, its credentials — is kept out of this repository, because
it is a map to where a full copy of the Tier-0 set sits. What follows is what any
implementation of it has to do, this one or the one under _later_.

- **D1:** short pages of `SELECT`s through the D1 query API, for every
  `ACCOUNTS_DB_n` and then `DIRECTORY_DB` — the list derived from
  `wrangler.jsonc`, so that a new shard is backed up without anyone remembering
  to add it. **Never `wrangler d1 export`** (_Never block the database_, below).
  The dump is plain SQL (the schema, then one `INSERT` per row) that
  `wrangler d1 execute --file` and `sqlite3` both load. Every literal in it is
  made by the database's own `quote()`, so blobs, text and integers past 2^53
  come back exact. Each dump is checked for its key table (`usernames`,
  `account_keys`) before it is kept.
- **R2:** a mirror in which any object a run would overwrite or delete is first
  moved aside under that run's date. That is the versioning R2 does not have.
  Never a plain copy, and never a mirror without the history.
- **Read-only credentials, separate from the deploy token.** A job that runs
  unattended holds only a **D1 Read** token and an R2 **Object Read** key pair,
  per tier — never a write credential. "Read-only" is checked, not assumed: every
  run sends a write that matches no rows, and stops if it is allowed. Restores
  use a write credential the job never holds (_restore drill_). Same rule as
  every other credential: never a file in the worktree (`CLAUDE.md`,
  _Tripwires_; [env-files.md](./env-files.md)).
- **A half-finished run never looks finished.** A day's dumps appear together or
  not at all.

**⚠ Never block the database.** `wrangler d1 export` is off the table:
Cloudflare says "a running export will block other database requests", and
there is no quiet hour to hide that in, because users are in every time zone. A
read-only token doesn't change it (the block comes from the export, not the
token), and Time Travel can't avoid it, since it only restores in place and
can't export or clone a past point. So the backup pages: each page is **one**
`SELECT` of a few hundred rows. That is atomic, so the page is exact, and it
holds the database no longer than any other request.

What paging gives up is one instant for the whole database. So the backup
**chooses its unit of consistency** instead: whatever the API writes in one
statement or one batch is read in one statement.

- **`DIRECTORY_DB` is written one statement at a time**, so a row is the unit
  and a page of rows is exact.
- **A shard's `users` row and its `account_keys` doors are written in one batch**
  (create-account, delete-account), so they are read in one statement: each page
  is users, with each user's doors joined in. The doors are never paged on
  their own. Otherwise a door re-wrapped between two pages, or an account
  created between them, would restore as an account that can't sign in.
- **Across databases there was never one instant.** Create-account and
  delete-account write the directory **first**, then the shard, so the backup
  reads the shards **first**, then the directory. Whatever lands between the two
  reads shows up as the directory being ahead of the shard. The live system
  already produces that state and already finishes it (_restore drill_, step 3).
- ⚠ **A new table inherits none of this.** If it is written in the same batch as
  another, it has to be read in the same statement too. Otherwise the default,
  one row at a time, is silently wrong for it.

So each backup restores **on its own**. Nothing is merged across days. What
paging costs is that the few minutes a run takes are a band rather than an
instant: a change made during the run may or may not be in it, and the next run
has it. That is the same loss any backup has for changes after it.

**⚠ Retention is a public promise: 30 days.** /privacy (_How long we keep it_)
and /delete-account (_What is deleted_, _What is kept_) say backups are deleted
automatically after 30 days. That means anything a user deletes, their key blobs
included, leaves the backups within 30 days. It is the same window as D1 Time
Travel and DO PITR, so one number holds everywhere, and it can't go below 30,
because Cloudflare's own history is fixed at 30 days. The number is written
**once**, as `BACKUP_RETENTION_DAYS` in the marketing site's `lib/site.ts`, which
both pages read; whatever prunes our own copies reads it from there rather than
keeping a second copy that could drift. What makes the promise hold, whatever
holds the copy:

- **Prune two days inside the window**, so the day between a deletion and the
  next run can't push a copy past the promise.
- **Prune first**, before anything that can fail, so a job that fails every day
  still deletes on schedule.
- **Nothing is kept past the window**, not even the newest copy when every run
  since has failed.
- **Nothing underneath the copy keeps it longer** — no machine backup or
  filesystem snapshot, no sync folder, no provider's version history, no Object
  Lock. Each of those is a retention of its own, and would be a promise of its
  own.
- **While nothing can prune, nothing can read.** Storage that is offline can't
  run the job, so it is encrypted at rest for that time.

**⚠ The dumps are encrypted before they are stored, and the key is kept apart
from them.** They hold every wrapped DEK, and a wrapped DEK is open to offline
password guessing — so whoever takes the storage that holds the copies must get
ciphertext only. The dumps are encrypted with `age` to a public key; the
matching identity never sits with them. Losing the identity makes every dump
unreadable, so it is kept in two places.

#### restore drill

A drill proves two different things, and only the second is the one that
matters. A real restore adds a third step:

1. **The dumps decrypt and load** — decrypt the newest set, load each into
   scratch SQLite, and compare row counts.
2. **A wrapped DEK still unwraps.** Restore into a scratch database and sign in
   to an account whose password you know.
3. **Finish what the run caught** (a real restore only). Two shapes can come
   back, both of them states the live system already makes:
   - _A claim with no account_ — a `usernames` row, not tombstoned, whose
     `user_id` has no `users` row in its shard: an account created during the
     run. It is the orphan claim that create-account's compensation (and its
     planned sweeper) releases. Release it.
   - _A tombstone with an account_ — a tombstoned `usernames` row whose shard
     still has the `users` row and doors: an account deleted during the run.
     **Delete those shard rows.** The user asked for deletion, and a restore must
     not bring it back.

A D1 dump restores with `wrangler d1 execute <db> --remote --file <dump.sql>`
into a new, empty database. R2 restores by copying in the other direction, with
a **write** credential that the backup job never holds. Each user's objects sit
under their prefix (`r2/keys.ts`), and an older version of an object is in the
history of the run that replaced it.

### later — the server-side pipeline

Once the pull is the wrong thing to depend on — the uptime of the machine it
runs on, or a run that takes too long for its band to stay narrow:

- **D1:** a scheduled Workflow pages through each Tier-0 db the same way, by
  the same rules (_Never block the database_), and copies the dump off
  Cloudflare. Through a binding, a `batch()` is a transaction, which makes the
  per-account read even simpler. Not Cloudflare's own
  [backup example](https://developers.cloudflare.com/workflows/examples/backup-d1/):
  it calls the export, and the export blocks.
- **R2:** R2 event notifications → Queue → Worker, copying every write **and
  delete** to an S3 or B2 bucket with **versioning** enabled. That provider keeps
  the history, so the mirror can be exact.
- **Both inherit the 30-day promise.** Dumps expire at 30 days, and the versioned
  bucket needs a lifecycle rule that expires **noncurrent** versions and delete
  markers within it. No Object Lock retention longer than the window either. A
  Worker can't import the marketing site, so `BACKUP_RETENTION_DAYS` moves to
  `shared` when the first one needs it.
- **The privacy page moves with it.** The new provider goes on its provider
  list, and _Where your data is_ stops saying our off-Cloudflare copies are held
  by us rather than by a provider — that sentence is only true while no provider
  holds one. Bump `PRIVACY_UPDATED`.
- Keep the pull alongside either one, as the copy we hold ourselves.

> Cloudflare references: [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
> [D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/),
> [D1 export and its block](https://developers.cloudflare.com/d1/best-practices/import-export-data/),
> [SQLite-backed DO storage + PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
> R2 has **no** native object versioning or replication as of 2026-09; keys live in D1 for that
> reason, and bulk R2 data is replicated rather than versioned.

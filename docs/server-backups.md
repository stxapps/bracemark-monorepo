## server backups & replication

How the server-side state is backed up, replicated and restored. Not to be
confused with the user-facing **bracemark backup** archive (export ⇄ import),
which is [data-lifecycle.md](./data-lifecycle.md). Why the Tier-0 set is Tier-0,
and why it lives in D1, is [account.md](./account.md#storage-durability--the-most-critical-state-in-the-system);
what R2 and the Durable Object hold is [local-first-sync.md](./local-first-sync.md).

### what each store needs

| store                                   | holds                                        | stakes                                                 | protection                                       |
| --------------------------------------- | -------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| `DIRECTORY_DB` (D1)                     | `usernames`, `purchases`, `paddle_checkouts` | **Tier-0** — the only path from a handle to an account | Time Travel + daily export + off-Cloudflare copy |
| each account shard (`ACCOUNTS_DB_1`, …) | `users`, `account_keys` (wrapped DEKs)       | **Tier-0** — lose it and the account is dead           | Time Travel + daily export + off-Cloudflare copy |
| `SESSIONS_DB` (D1)                      | `sessions`                                   | disposable — loss signs everyone out                   | none                                             |
| `USER_FILES` (R2)                       | every user's encrypted files                 | **source of truth** for bookmark data                  | replicate to a second bucket                     |
| `USER_DATA` (Durable Object, per user)  | op log, `file_sizes` quota map               | op log disposable; quota map derivable from R2         | built-in 30-day PITR only                        |

### backups & replication (set up before launch)

- **D1 Tier-0 set — `DIRECTORY_DB` + every account shard:** Time Travel is always
  on and free — any point in the **last 30 days** is restorable
  (`wrangler d1 time-travel restore`). Note these are **separate databases with
  separate timelines**, so a point-in-time restore that must stay consistent
  across the directory and a shard is a per-db operation — pick a quiet point and
  restore each. For retention beyond 30 days, run a **scheduled D1 export** (REST
  API + Workflows / a Cron-triggered Worker) daily for **each** of these dbs, and
  copy at least the weekly dump **off Cloudflare** (e.g. to S3) so a
  platform-level account problem can't take the Tier-0 state with it.
  (`SESSIONS_DB` is not Tier-0 — skip it.)
- **R2 (bulk ciphertext):** R2 is durable but **not versioned**, and it is the
  **source of truth** for bookmark data
  ([local-first-sync.md](./local-first-sync.md#source-of-truth-r2-is-truth-the-op-log-is-an-accelerator)).
  A client's local copy is a replica only for as long as that client exists: a
  new device's first sync, and every fallback full sync, is download-authoritative
  from R2, so a user whose only device is gone has nothing but R2. It is less
  catastrophic than the Tier-0 set — ciphertext without a DEK is useless, but a
  DEK without ciphertext is an empty account, not a dead one — yet it is not a
  second-class copy. Guard against accidental delete/overwrite with **R2 event
  notifications → Queue → Worker** replicating writes to a second bucket.
- **The per-user Durable Object:** nothing beyond the built-in 30-day PITR of
  SQLite-backed DOs, deliberately. The op log is a disposable accelerator —
  losing it only routes clients into the fallback full sync against R2. The
  `file_sizes` quota map is durable, but it is `path → size` for objects that
  are in R2, so an R2 listing reproduces it (no rebuild path exists in code yet;
  write it if a DO is ever lost, rather than backing the map up).
- **Test restores.** A backup you have never restored is not a backup —
  periodically restore D1 to a scratch DB and confirm a sample of wrapped DEKs
  still unwrap.

### R2 hygiene

Keep the bookmark bucket free of any **lifecycle rule** that could silently expire
a user's server copy — nothing errors when one fires; the objects are simply gone,
and with R2 as the source of truth there is no copy to converge back from. Route
deletes through a separate admin path, not the hot request path.

### still open

- The daily export + off-Cloudflare copy for `DIRECTORY_DB` **and** each account
  shard (the two together are the Tier-0 set) — don't wait for the first real
  user.
- R2 → second-bucket replication.
- A restore drill.

> Cloudflare references: [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
> [D1 export](https://developers.cloudflare.com/d1/wrangler-commands/),
> [SQLite-backed DO storage + PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
> R2 has **no** native object versioning as of 2026-06; keys live in D1 for that
> reason, and bulk R2 data is replicated rather than versioned.

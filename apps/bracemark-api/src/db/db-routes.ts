import type { Bindings } from '../lib/env';

// Resolve a stored `account_db_id` to the D1 binding holding that user's `users`
// + `account_keys` rows (an ACCOUNTS_DB_N shard). This is the sharding SEAM. Two
// properties make adding capacity a non-migration:
//
//  - Routing READS the stored id; it never hashes the userId. So once a user is
//    assigned to a shard they stay there for life — adding a shard never moves
//    anyone (unlike `hash(userId) % N`, where changing N rehashes everyone).
//  - `account_db_id` is stored explicitly on every account (NOT NULL) at
//    create-account, so each row self-describes its shard and existing rows are
//    never rewritten when a shard is added.
//  - The global `usernames` directory is NOT routed here — it always lives in
//    env.DIRECTORY_DB (global uniqueness can't be sharded). Only user/account_keys
//    reads/writes route through this function.
//
// To add ACCOUNTS_DB_2: provision it, add its binding in wrangler.jsonc +
// lib/env.ts, add the `case '2'` below, and start handing new signups id '2' from
// assignAccountDbId(). Existing rows keep their stored id, untouched.
export function accountsDb(env: Bindings, accountDbId: string): D1Database {
  switch (accountDbId) {
    case '1':
      return env.ACCOUNTS_DB_1;
    // case '2':
    //   return env.ACCOUNTS_DB_2;
    default:
      throw new Error(`accountsDb: unknown account_db_id "${accountDbId}"`);
  }
}

// The shard a NEW account is placed in — the single source of truth for
// placement, called by create-account and stored on the account. Today a
// constant '1'; when a second shard comes online this becomes the placement
// policy (e.g. the least-full shard, or "the newest until it fills"), at which
// point it may need `env` and/or to become async. Resolve the returned id back
// to a binding with accountsDb().
export function assignAccountDbId(): string {
  return '1';
}

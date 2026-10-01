import type { SeedPlan } from './catalog';
import { d1, quote } from './d1';

// Granting a seeded account its plan — the one part of the seed that writes to the
// server, because it is the one part the server actually knows.
//
// Everything else a seeded account owns (links, lists, tags, pins) is
// end-to-end encrypted: bracemark-api holds opaque AES-GCM blobs and cannot read,
// let alone author, a single title (docs/local-first-sync.md, _crypto boundary_).
// A subscription is the opposite — plaintext state in D1, folded server-side into
// the entitlements every client reads back from `GET /v1/iap/status`. So the split
// is not a shortcut, it is the encryption boundary: data goes in through the app,
// the plan goes in through the database, and neither can be done the other way.
//
// The row is a `manual` purchase with a NULL expiry — the source that already
// exists for comps and lifetime grants (apps/bracemark-api/src/db/schemas/directory.sql),
// which `isEntitled` reads as never-expiring and `needsRefresh` skips outright
// because there is no provider to ask. Nothing test-only is being added to the
// api to make this work, and nothing here is reachable from a deployed
// environment: `--local` reads and writes miniflare's SQLite under
// `apps/bracemark-api/.wrangler/`.

// The user id behind a username, or null if the name has never been claimed.
// Usernames are stored canonical (trim → NFKC → lowercase), and every seeded name
// is already lowercase ASCII, so this compares as-is.
//
// A tombstoned row (deleted_at set) is deliberately treated as "not there": the
// name stays occupied forever but the account behind it is gone, so create-account
// will fail and sign-in will fail, and the seed should say so rather than grant a
// plan to a user id that no longer exists.
export async function findUserId(username: string): Promise<string | null> {
  const rows = await d1(
    'DIRECTORY_DB',
    `SELECT user_id, deleted_at FROM usernames WHERE username = ${quote(username)}`,
  );
  const row = rows[0];
  if (!row) return null;
  if (row.deleted_at !== null && row.deleted_at !== undefined) {
    throw new Error(
      `username "${username}" is tombstoned — its account was deleted and the name cannot be ` +
        `re-claimed. Clear local api state (rm -rf apps/bracemark-api/.wrangler) and re-seed.`,
    );
  }
  return String(row.user_id);
}

// Grant (or re-grant) the plan. Idempotent on `UNIQUE(source, external_id)`: the
// external id is derived from the user id, so re-seeding updates the one row
// rather than stacking grants — which matters because the fold takes the BEST
// entitled row and a stale `free`-shaped leftover would be invisible.
export async function grantPlan(userId: string, plan: Exclude<SeedPlan, 'free'>): Promise<void> {
  const now = Date.now();
  const externalId = `seed-${userId}`;
  await d1(
    'DIRECTORY_DB',
    `INSERT INTO purchases (
       id, user_id, source, external_id, plan, status, provider_customer_id,
       expires_at, canceled_at, linked_external_id, event_occurred_at,
       last_synced_at, created_at, updated_at
     ) VALUES (
       ${quote(`seed-purchase-${userId}`)}, ${quote(userId)}, 'manual', ${quote(externalId)},
       ${quote(plan)}, 'active', NULL,
       NULL, NULL, NULL, ${now},
       ${now}, ${now}, ${now}
     )
     ON CONFLICT (source, external_id) DO UPDATE SET
       plan = excluded.plan,
       status = excluded.status,
       expires_at = NULL,
       canceled_at = NULL,
       event_occurred_at = excluded.event_occurred_at,
       updated_at = excluded.updated_at`,
  );
}

// End the grant: the same row, canceled, its expiry a moment in the past. That
// is how a comp or an operator-granted plan ends in production — the row stays
// (purchases are Tier-0 history), and the fold stops entitling it because a
// `canceled` row is entitled only until `expires_at`, with no slack
// (`isEntitled`, services/iap.ts). `needsRefresh` never looks at it either:
// `manual` has no provider and `canceled` is terminal. Deleting the row instead
// would be a state no production account reaches. Used by IAP-DOWNGRADE-001.
//
// The high-water ceilings (`foldQuotaCeilings`) deliberately keep the plan this
// row once held, so the lapsed account's byte/object ceiling does not drop —
// docs/iap.md, _enforcement_. Nothing here needs to undo that.
export async function lapsePlan(userId: string): Promise<void> {
  const now = Date.now();
  await d1(
    'DIRECTORY_DB',
    `UPDATE purchases SET
       status = 'canceled',
       expires_at = ${now - 1000},
       canceled_at = ${now},
       event_occurred_at = ${now},
       updated_at = ${now}
     WHERE source = 'manual' AND external_id = ${quote(`seed-${userId}`)}`,
  );
}

// What the account is entitled to right now, straight off the row — used to
// confirm the grant landed before the seed imports a library that a free plan
// would refuse whole.
export async function readGrantedPlan(userId: string): Promise<string | null> {
  const rows = await d1(
    'DIRECTORY_DB',
    `SELECT plan FROM purchases WHERE user_id = ${quote(userId)} AND status = 'active'`,
  );
  return rows[0] ? String(rows[0].plan) : null;
}

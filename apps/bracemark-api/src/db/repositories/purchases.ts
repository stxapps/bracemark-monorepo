import type { Plan, SubscriptionSource } from '@stxapps/shared';

// Purchase repository — subscription rows in DIRECTORY_DB (global, NOT an
// account shard: webhook events arrive keyed by the provider's subscription id,
// so the lookup must be un-sharded — see the schema note in
// db/schemas/directory.sql). Statuses are already NORMALIZED here (the webhook
// edge maps provider vocab before writing), so the fold in services/iap.ts
// never sees provider-specific states.

// Normalized subscription lifecycle states, a superset small enough for every
// provider to map onto: Paddle uses these words natively; the App Store /
// Play Store verifiers map their state enums onto them later.
export const PURCHASE_STATUSES = ['active', 'trialing', 'past_due', 'paused', 'canceled'] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

// Public domain entity (camelCase).
export type PurchaseEntity = {
  id: string;
  userId: string;
  source: SubscriptionSource;
  externalId: string;
  plan: Exclude<Plan, 'free'>;
  status: PurchaseStatus;
  providerCustomerId: string | null;
  expiresAt: number | null; // epoch ms; null = non-expiring (manual/lifetime)
  canceledAt: number | null;
  // PLAY ONLY — the purchase token this row replaced (see the schema note).
  // Null for every other source, and for a Play row that started a chain.
  linkedExternalId: string | null;
  // Last refresh ATTEMPT against the provider (see the schema note) — read by
  // the staleness gate in services/iap.ts to debounce, never by the fold.
  lastSyncedAt: number;
};

// Raw row as it sits in D1 (snake_case columns). Internal to this repo.
type PurchaseRow = {
  id: string;
  user_id: string;
  source: string;
  external_id: string;
  plan: string;
  status: string;
  provider_customer_id: string | null;
  expires_at: number | null;
  canceled_at: number | null;
  linked_external_id: string | null;
  last_synced_at: number;
};

const SELECT_COLUMNS = `id, user_id, source, external_id, plan, status,
       provider_customer_id, expires_at, canceled_at, linked_external_id,
       last_synced_at`;

function toEntity(r: PurchaseRow): PurchaseEntity {
  return {
    id: r.id,
    userId: r.user_id,
    source: r.source as SubscriptionSource,
    externalId: r.external_id,
    plan: r.plan as Exclude<Plan, 'free'>,
    status: r.status as PurchaseStatus,
    providerCustomerId: r.provider_customer_id,
    expiresAt: r.expires_at,
    canceledAt: r.canceled_at,
    linkedExternalId: r.linked_external_id,
    lastSyncedAt: r.last_synced_at,
  };
}

export function purchasesRepo(db: D1Database) {
  return {
    // Everything ever purchased by this user — the fold's input (a handful of
    // rows at most; the fold picks the entitled one, so no WHERE on status here).
    async listByUserId(userId: string): Promise<PurchaseEntity[]> {
      const { results } = await db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM purchases WHERE user_id = ?`)
        .bind(userId)
        .all<PurchaseRow>();
      return results.map(toEntity);
    },

    // The webhook's write: one idempotent, out-of-order-safe upsert keyed by the
    // provider's subscription identity. Three guards live in the SQL itself:
    //  - `ON CONFLICT ... WHERE excluded.event_occurred_at >= event_occurred_at`
    //    drops a STALE event (Paddle retries + redeliveries arrive unordered);
    //  - `user_id` is deliberately NOT in the update set — first sight of a
    //    subscription binds it to an account for life, so a crafted later event
    //    can't re-point someone else's subscription at the attacker's account;
    //  - `expires_at = COALESCE(excluded…, purchases…)` keeps the last known
    //    period end when an event (e.g. an immediate cancel) omits it, while
    //    `canceled_at` IS overwritten as sent — null must be able to CLEAR it
    //    (the user resumed a scheduled cancellation).
    // `last_synced_at` is stamped `now` on both insert and update: applying
    // provider state IS a sync, whether it arrived by webhook or by refetch, so
    // a subscription whose events land normally never trips the staleness gate.
    // A STALE event loses the whole update set including this — correct, since
    // it taught us nothing about the current state.
    async upsertFromProvider(p: {
      id: string; // used only on INSERT (a fresh newId()); conflicts keep the stored id
      userId: string;
      source: SubscriptionSource;
      externalId: string;
      plan: Exclude<Plan, 'free'>;
      status: PurchaseStatus;
      providerCustomerId: string | null;
      expiresAt: number | null;
      canceledAt: number | null;
      linkedExternalId?: string | null; // Play only; see the type note
      eventOccurredAt: number;
    }): Promise<void> {
      const now = Date.now();
      await db
        .prepare(
          `INSERT INTO purchases (
             id, user_id, source, external_id, plan, status,
             provider_customer_id, expires_at, canceled_at, linked_external_id,
             event_occurred_at, last_synced_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (source, external_id) DO UPDATE SET
             plan                 = excluded.plan,
             status               = excluded.status,
             provider_customer_id = COALESCE(excluded.provider_customer_id, provider_customer_id),
             expires_at           = COALESCE(excluded.expires_at, expires_at),
             canceled_at          = excluded.canceled_at,
             linked_external_id   = COALESCE(excluded.linked_external_id, linked_external_id),
             event_occurred_at    = excluded.event_occurred_at,
             last_synced_at       = excluded.last_synced_at,
             updated_at           = excluded.updated_at
           WHERE excluded.event_occurred_at >= event_occurred_at`,
        )
        .bind(
          p.id,
          p.userId,
          p.source,
          p.externalId,
          p.plan,
          p.status,
          p.providerCustomerId,
          p.expiresAt,
          p.canceledAt,
          p.linkedExternalId ?? null,
          p.eventOccurredAt,
          now,
          now,
          now,
        )
        .run();
    },

    // Retire a row REPLACED by a newer purchase: end it now and mark it
    // canceled, so the fold stops entitling it (services/iap.ts isEntitled
    // gives 'canceled' no expiry slack). Play-only in practice — the
    // linkedPurchaseToken chain, see supersedeLinkedPlayPurchase.
    //
    // Three deliberate differences from upsertFromProvider, all because this is
    // an INFERENCE we are asserting rather than a provider event we are
    // applying:
    //  - NOT scoped to a user_id. The replaced token may be bound to a DIFFERENT
    //    account than the replacement (re-signup while signed into a second
    //    account) — retiring only the caller's own rows would leave exactly the
    //    duplicate-entitlement hole this exists to close.
    //  - No `event_occurred_at` guard, and the column is left alone. Ordering
    //    that column against provider events would let a stale-looking clock
    //    drop the retirement; supersession isn't a state report that a newer
    //    one supersedes, it's terminal.
    //  - `expires_at` moves BACKWARD (MIN). Provider writes only do that when
    //    reporting a clawback (an Apple revocation / a Paddle immediate cancel
    //    — provider-stated facts); here the pull-back is our own inference,
    //    hence MIN rather than an overwrite.
    // Idempotent: MIN keeps the earliest end, COALESCE keeps the first
    // canceled_at, so replaying it is a no-op. Returns whether a row existed.
    async supersedeByExternalId(
      source: SubscriptionSource,
      externalId: string,
      at: number = Date.now(),
    ): Promise<boolean> {
      const res = await db
        .prepare(
          `UPDATE purchases
              SET status         = 'canceled',
                  canceled_at    = COALESCE(canceled_at, ?),
                  expires_at     = MIN(COALESCE(expires_at, ?), ?),
                  last_synced_at = ?,
                  updated_at     = ?
            WHERE source = ? AND external_id = ?`,
        )
        .bind(at, at, at, at, at, source, externalId)
        .run();
      return (res.meta?.changes ?? 0) > 0;
    },

    // Stamp a refresh ATTEMPT without touching state — the failure path of
    // services/iap.ts's refreshPurchase (provider unreachable, 404, a snapshot
    // we can't apply). Without this a permanently-unrefreshable row would fire
    // an outbound call on EVERY status read of that account; with it, a failure
    // costs the same one call per debounce window a success does.
    async markSyncAttempt(
      source: SubscriptionSource,
      externalId: string,
      at: number = Date.now(),
    ): Promise<void> {
      await db
        .prepare(`UPDATE purchases SET last_synced_at = ? WHERE source = ? AND external_id = ?`)
        .bind(at, source, externalId)
        .run();
    },

    // The account a subscription is already bound to (or null when unseen) —
    // read by the webhook to keep `user_id` first-write-wins even when a later
    // event carries a different custom_data.userId.
    async findBySourceExternalId(
      source: SubscriptionSource,
      externalId: string,
    ): Promise<PurchaseEntity | null> {
      const row = await db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM purchases WHERE source = ? AND external_id = ?`)
        .bind(source, externalId)
        .first<PurchaseRow>();
      return row ? toEntity(row) : null;
    },
  };
}

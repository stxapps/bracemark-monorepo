import type { Plan } from '@stxapps/shared';

// Pending-Paddle-checkout repository — rows in DIRECTORY_DB beside `purchases`
// (see the schema note in db/schemas/directory.sql for why the table exists at
// all: it is the only account → Paddle mapping that predates a subscription,
// and Paddle cannot be queried by our `custom_data.userId`).
//
// The table has ONE meaning — "this account started a checkout we have not seen
// a subscription for" — so pending is `row exists`, with no status column: the
// resolve path in services/iap.ts DELETES on every terminal outcome (applied,
// canceled, unknown to Paddle) and ages the rest out. Keeping it that narrow is
// what makes the reconciliation gate a plain existence check.

// Public domain entity (camelCase).
export type PaddleCheckoutEntity = {
  transactionId: string;
  userId: string;
  plan: Exclude<Plan, 'free'>;
  createdAt: number;
  // Last resolve ATTEMPT against Paddle — read by the debounce in
  // services/iap.ts, never by any fold. 0 = never attempted.
  lastSyncedAt: number;
};

type PaddleCheckoutRow = {
  transaction_id: string;
  user_id: string;
  plan: string;
  created_at: number;
  last_synced_at: number;
};

const SELECT_COLUMNS = `transaction_id, user_id, plan, created_at, last_synced_at`;

function toEntity(r: PaddleCheckoutRow): PaddleCheckoutEntity {
  return {
    transactionId: r.transaction_id,
    userId: r.user_id,
    plan: r.plan as Exclude<Plan, 'free'>,
    createdAt: r.created_at,
    lastSyncedAt: r.last_synced_at,
  };
}

export function paddleCheckoutsRepo(db: D1Database) {
  return {
    // Record a checkout we just created at Paddle. `ON CONFLICT DO NOTHING`
    // because the transaction id is Paddle's and already unique — a retry that
    // somehow re-presents one must not reset its debounce clock.
    async create(c: {
      transactionId: string;
      userId: string;
      plan: Exclude<Plan, 'free'>;
      createdAt?: number;
    }): Promise<void> {
      await db
        .prepare(
          `INSERT INTO paddle_checkouts (transaction_id, user_id, plan, created_at, last_synced_at)
           VALUES (?, ?, ?, ?, 0)
           ON CONFLICT (transaction_id) DO NOTHING`,
        )
        .bind(c.transactionId, c.userId, c.plan, c.createdAt ?? Date.now())
        .run();
    },

    // This account's pending checkouts, newest first — the reconciliation input.
    // `limit` bounds the scan; the caller applies the age/debounce policy
    // (needsCheckoutResolve) and its own cap on outbound calls.
    async listPendingByUserId(userId: string, limit = 10): Promise<PaddleCheckoutEntity[]> {
      const { results } = await db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM paddle_checkouts
           WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(userId, limit)
        .all<PaddleCheckoutRow>();
      return results.map(toEntity);
    },

    // Stamp a resolve ATTEMPT without resolving — the same debounce discipline
    // purchases.markSyncAttempt enforces: a transaction Paddle can't answer for
    // (down, or simply not paid yet) costs one call per window, not one per poll.
    async markSyncAttempt(transactionId: string, at: number = Date.now()): Promise<void> {
      await db
        .prepare(`UPDATE paddle_checkouts SET last_synced_at = ? WHERE transaction_id = ?`)
        .bind(at, transactionId)
        .run();
    },

    // Terminal: the checkout produced a purchase row, or never will.
    async delete(transactionId: string): Promise<void> {
      await db
        .prepare(`DELETE FROM paddle_checkouts WHERE transaction_id = ?`)
        .bind(transactionId)
        .run();
    },

    // Drop this account's aged-out rows. Called from the two paths that already
    // touch the table (a new checkout, a reconciliation scan) rather than by a
    // sweep — past the TTL a row can no longer do anything, so deleting it is
    // pure cleanup and never needs to be timely.
    async deleteStale(userId: string, createdBefore: number): Promise<void> {
      await db
        .prepare(`DELETE FROM paddle_checkouts WHERE user_id = ? AND created_at < ?`)
        .bind(userId, createdBefore)
        .run();
    },
  };
}

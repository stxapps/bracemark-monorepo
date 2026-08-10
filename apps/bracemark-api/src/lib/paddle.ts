import { z } from 'zod';

import type { PurchaseStatus } from '../db/repositories/purchases';
import type { Bindings } from './env';

// Paddle Billing webhook plumbing: signature verification and the typed slice of
// a subscription event the service consumes. This is the PROVIDER-VOCAB edge —
// everything Paddle-shaped is parsed/normalized here so services/iap.ts and the
// purchases repo only ever see our normalized statuses and epoch-ms times.
//
// NOTE this is Paddle BILLING (the current platform: `Paddle-Signature` HMAC
// header, `sub_…`/`ctm_…`/`pri_…` ids, subscription.* events) — NOT Paddle
// Classic (p_signature RSA verification, vendor/product ids), which the old
// stxapps iap-server used and which is closed to new accounts.

// How stale a webhook's `ts=` may be before we reject it (replay bound; Paddle's
// docs suggest rejecting anything older than ~5 seconds but allow for retries —
// we take 5 minutes, matching the auth-proof TIMESTAMP_WINDOW_MS posture).
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

// Verify a `Paddle-Signature: ts=<unix-seconds>;h1=<hex>` header: the signed
// payload is `${ts}:${rawBody}` (the EXACT raw body bytes — never a re-serialized
// parse), MACed with the per-notification-destination webhook secret. `h1` may
// appear more than once during secret rotation; any match passes.
export async function verifyPaddleSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (!header) return false;

  let ts: string | null = null;
  const h1s: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts') ts = value;
    else if (key === 'h1') h1s.push(value);
  }
  if (!ts || h1s.length === 0) return false;

  const tsMs = Number(ts) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > SIGNATURE_MAX_AGE_MS) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${ts}:${rawBody}`)),
  );
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');

  return h1s.some((h1) => timingSafeEqualHex(h1, expected));
}

// Constant-time string compare (both sides are lowercase hex of fixed HMAC
// length; a length mismatch short-circuits, which leaks only the length — public
// anyway for SHA-256).
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The slice of a Paddle SUBSCRIPTION we consume, permissively typed
// (`looseObject` everywhere — Paddle adds fields freely and unknown ones must
// pass through; a shape we can't parse is logged and ACKed, never 500ed, or
// Paddle retries a permanently-unparseable event forever).
//
// Deliberately shared by both directions: it's the `data` of a subscription.*
// webhook event AND the `data` of a GET /subscriptions/{id} response, which
// Paddle documents as the same subscription entity. That identity is what lets
// services/iap.ts apply a pushed event and a pulled refetch through one code
// path (applyPaddleSubscription) — see fetchPaddleSubscription below.
export const paddleSubscriptionSchema = z.looseObject({
  id: z.string(), // sub_… for subscription.* events
  status: z.string(),
  customer_id: z.string().nullish(),
  // Set by OUR checkout (customData: { userId }) and persisted onto the
  // subscription by Paddle, so every later event carries it back.
  custom_data: z.looseObject({ userId: z.string().optional() }).nullish(),
  items: z.array(z.looseObject({ price: z.looseObject({ id: z.string() }).nullish() })).optional(),
  current_billing_period: z.looseObject({ ends_at: z.string() }).nullish(),
  canceled_at: z.string().nullish(),
  // A pending change scheduled for period end — action 'cancel' means the user
  // canceled but stays entitled until effective_at (willRenew=false); the field
  // going back to null means they resumed.
  scheduled_change: z
    .looseObject({ action: z.string(), effective_at: z.string().nullish() })
    .nullish(),
  // The txn_… that CAUSED Paddle to create this subscription — i.e. our own
  // checkout transaction, handed back so the two can be matched during
  // provisioning. Paddle documents it on `subscription.created` ONLY (it is
  // absent from later subscription.* events and from GET /subscriptions/{id}),
  // which is exactly the event that retires a pending checkout row: it's the
  // one place the push path learns the key that table is keyed on
  // (services/iap.ts applyPaddleEvent).
  transaction_id: z.string().nullish(),
});
export type PaddleSubscription = z.infer<typeof paddleSubscriptionSchema>;

export const paddleEventSchema = z.looseObject({
  event_id: z.string(),
  event_type: z.string(),
  occurred_at: z.string(), // ISO 8601
  data: paddleSubscriptionSchema,
});
export type PaddleEvent = z.infer<typeof paddleEventSchema>;

// PULL the authoritative state of one subscription — the Paddle sibling of
// fetchAppstoreSubscription / fetchPlaystoreSubscription, and the piece that
// makes Paddle recoverable when a webhook never lands (delivery exhausted its
// retries, the destination was disabled, or WE ACKed an event and dropped it —
// see the log-and-drop branches in services/iap.ts, which are permanent by
// design since a 200 is never redelivered).
//
// Null means Paddle doesn't know this subscription id (404) — a caller-decided
// non-event, never an error. Any other failure THROWS: it's transient, and the
// caller must keep the stored row rather than treat "couldn't ask" as "gone".
export async function fetchPaddleSubscription(
  env: Bindings,
  subscriptionId: string,
): Promise<PaddleSubscription | null> {
  // The id is interpolated into the URL path — reject anything that could change
  // the path shape before it reaches fetch (Paddle ids are `sub_` + base32-ish,
  // but being strict costs nothing). Same guard as the store fetchers.
  if (!/^[A-Za-z0-9._-]+$/.test(subscriptionId)) return null;

  const res = await fetch(`${env.PADDLE_API_BASE}/subscriptions/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${env.PADDLE_API_KEY}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.error(`fetchPaddleSubscription: Paddle API ${res.status}`);
    throw new Error(`Paddle API ${res.status}`);
  }

  const parsed = z.looseObject({ data: paddleSubscriptionSchema }).safeParse(await res.json());
  if (!parsed.success) {
    console.error('fetchPaddleSubscription: unexpected response shape', parsed.error.message);
    return null;
  }
  return parsed.data.data;
}

// The slice of a Paddle TRANSACTION we consume. A transaction is what our
// checkout creates (createPaddleTransaction) and what the overlay bills; a
// successful one GROWS a `subscription_id` once Paddle has provisioned the
// subscription. That field is the entire point of this fetch: it's the hop from
// the only Paddle handle we can persist BEFORE a purchase exists (the txn_… we
// minted) to the sub_… the whole rest of the system is keyed on.
export const paddleTransactionSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  subscription_id: z.string().nullish(),
  custom_data: z.looseObject({ userId: z.string().optional() }).nullish(),
});
export type PaddleTransaction = z.infer<typeof paddleTransactionSchema>;

// Transaction statuses that will NEVER grow a subscription — the caller drops
// its pending row on sight rather than waiting out the TTL. Everything else
// (`draft`/`ready`/`billed`/`paid`/`completed`/`past_due`) is either in flight
// or already carries the subscription id.
export function isPaddleTransactionDead(status: string): boolean {
  return status === 'canceled';
}

// Transaction statuses that mean NO PAYMENT HAS BEEN ATTEMPTED yet: `draft`
// (created, still missing required fields) and `ready` (complete, awaiting
// checkout). Paying moves a transaction through `billed`/`paid`/`completed`
// BEFORE Paddle provisions the subscription, so a transaction that is still
// unbilled cannot be the scary case (paid, subscription never seen) — it's a
// checkout in progress or, once old enough, an abandoned one. Distinguishing
// those two is a clock, not a status, so the age policy stays with the caller
// (services/iap.ts CHECKOUT_ABANDONED_MS).
export function isPaddleTransactionUnbilled(status: string): boolean {
  return status === 'draft' || status === 'ready';
}

// PULL one transaction — the FIRST hop of the missed-first-webhook recovery
// (services/iap.ts resolvePendingCheckouts); `fetchPaddleSubscription` below is
// the second. Same contract as it: null for 404 (Paddle doesn't know this id),
// THROW for anything else (transient — the caller must not read "couldn't ask"
// as "never happened").
export async function fetchPaddleTransaction(
  env: Bindings,
  transactionId: string,
): Promise<PaddleTransaction | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(transactionId)) return null;

  const res = await fetch(`${env.PADDLE_API_BASE}/transactions/${transactionId}`, {
    headers: { Authorization: `Bearer ${env.PADDLE_API_KEY}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.error(`fetchPaddleTransaction: Paddle API ${res.status}`);
    throw new Error(`Paddle API ${res.status}`);
  }

  const parsed = z.looseObject({ data: paddleTransactionSchema }).safeParse(await res.json());
  if (!parsed.success) {
    console.error('fetchPaddleTransaction: unexpected response shape', parsed.error.message);
    return null;
  }
  return parsed.data.data;
}

// Paddle Billing subscription statuses happen to be exactly our normalized
// vocabulary (PURCHASE_STATUSES). Mapped explicitly anyway so a value Paddle
// adds later comes back null (→ log + ignore) instead of flowing into the fold.
const PADDLE_STATUS_MAP: Record<string, PurchaseStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  paused: 'paused',
  canceled: 'canceled',
};

export function normalizePaddleStatus(status: string): PurchaseStatus | null {
  return PADDLE_STATUS_MAP[status] ?? null;
}

// ISO 8601 → epoch ms, null for absent/unparseable (never NaN into the db).
export function paddleTimeToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

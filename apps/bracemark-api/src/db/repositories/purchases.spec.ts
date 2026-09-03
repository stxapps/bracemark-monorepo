import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { newId } from '../../lib/ids';
import { type PurchaseEntity, purchasesRepo } from './purchases';

// The three guards that live in the upsert's SQL rather than in any service,
// against real D1 (real ON CONFLICT, real WHERE-on-update). routes/iap.spec.ts
// drives the webhook end to end and covers what a provider event does to the
// fold — the out-of-order drop and the first-sight account binding among them.
// What it can't isolate is the field-level asymmetry this write depends on:
// `expires_at` is COALESCEd (an event that omits it teaches us nothing) while
// `canceled_at` is overwritten as sent (a null MUST clear it — that is a user
// resuming a scheduled cancellation). Getting either backwards is silent: the
// row still updates, the status is still right, and the account is simply
// entitled for the wrong span.
const repo = purchasesRepo(env.DIRECTORY_DB);
const DAY_MS = 24 * 60 * 60 * 1000;

type Event = Parameters<typeof repo.upsertFromProvider>[0];

function event(externalId: string, overrides: Partial<Event> = {}): Event {
  return {
    id: newId(),
    userId: `u_${externalId}`,
    source: 'paddle',
    externalId,
    plan: 'plus',
    status: 'active',
    providerCustomerId: 'ctm_1',
    expiresAt: Date.now() + 30 * DAY_MS,
    canceledAt: null,
    eventOccurredAt: Date.now(),
    ...overrides,
  };
}

async function read(
  externalId: string,
  source: PurchaseEntity['source'] = 'paddle',
): Promise<PurchaseEntity> {
  const row = await repo.findBySourceExternalId(source, externalId);
  if (!row) throw new Error(`no purchase row for ${externalId}`);
  return row;
}

describe('purchases.upsertFromProvider', () => {
  it('keeps the last known period end when a later event omits it', async () => {
    const periodEnd = Date.now() + 30 * DAY_MS;
    const first = event('sub_coalesce', { expiresAt: periodEnd });
    await repo.upsertFromProvider(first);

    // An immediate cancellation carries no current_billing_period — and a null
    // written through would read as "no expiry", which the fold does not entitle.
    await repo.upsertFromProvider(
      event('sub_coalesce', {
        status: 'canceled',
        expiresAt: null,
        providerCustomerId: null,
        eventOccurredAt: first.eventOccurredAt + 1000,
      }),
    );

    const row = await read('sub_coalesce');
    expect(row.status).toBe('canceled');
    expect(row.expiresAt).toBe(periodEnd);
    // Same reasoning for the customer handle: absent ≠ removed.
    expect(row.providerCustomerId).toBe('ctm_1');
  });

  it('clears canceled_at when the subscription is resumed', async () => {
    const canceledAt = Date.now();
    const first = event('sub_resumed', { status: 'canceled', canceledAt });
    await repo.upsertFromProvider(first);
    expect((await read('sub_resumed')).canceledAt).toBe(canceledAt);

    // The user resumed before the period ended: Paddle sends the subscription
    // back as active with canceled_at null. COALESCEing this field (as
    // expires_at is) would leave them permanently marked as cancelling.
    await repo.upsertFromProvider(
      event('sub_resumed', {
        status: 'active',
        canceledAt: null,
        eventOccurredAt: first.eventOccurredAt + 1000,
      }),
    );

    const row = await read('sub_resumed');
    expect(row.status).toBe('active');
    expect(row.canceledAt).toBeNull();
  });

  // The stale guard is `>=`, not `>`: two events can share a millisecond, and a
  // strict comparison would drop the second one for good (a 200 is never
  // redelivered).
  it('applies an event that arrives at the same instant as the stored one', async () => {
    const occurredAt = Date.now();
    await repo.upsertFromProvider(event('sub_sameinstant', { eventOccurredAt: occurredAt }));

    await repo.upsertFromProvider(
      event('sub_sameinstant', { status: 'past_due', eventOccurredAt: occurredAt }),
    );

    expect((await read('sub_sameinstant')).status).toBe('past_due');
  });

  it('stamps last_synced_at on every applied event, so a healthy row never looks stale', async () => {
    const first = event('sub_synced', { eventOccurredAt: Date.now() - 60_000 });
    await repo.upsertFromProvider(first);
    const inserted = await read('sub_synced');

    await repo.upsertFromProvider(
      event('sub_synced', { status: 'past_due', eventOccurredAt: Date.now() }),
    );

    expect((await read('sub_synced')).lastSyncedAt).toBeGreaterThanOrEqual(inserted.lastSyncedAt);
  });
});

describe('purchases.supersedeByExternalId', () => {
  it('retires a row now and stays idempotent on replay', async () => {
    await repo.upsertFromProvider(
      event('play_old_token', { source: 'playstore', expiresAt: Date.now() + 30 * DAY_MS }),
    );
    const firstAt = Date.now();

    expect(await repo.supersedeByExternalId('playstore', 'play_old_token', firstAt)).toBe(true);
    const once = await read('play_old_token', 'playstore');
    expect(once.status).toBe('canceled');
    expect(once.canceledAt).toBe(firstAt);
    expect(once.expiresAt).toBe(firstAt); // pulled back from the future period end

    // Replayed later (the chain can be walked again): the earliest end and the
    // first canceled_at both stand, so a retry never extends the entitlement.
    expect(await repo.supersedeByExternalId('playstore', 'play_old_token', firstAt + 60_000)).toBe(
      true,
    );
    const twice = await read('play_old_token', 'playstore');
    expect(twice.canceledAt).toBe(firstAt);
    expect(twice.expiresAt).toBe(firstAt);
  });

  it('reports false for a token we never recorded', async () => {
    expect(await repo.supersedeByExternalId('playstore', 'play_never_seen')).toBe(false);
  });
});

describe('purchases.markSyncAttempt', () => {
  // The debounce's whole job: a row we FAILED to refresh must still count as
  // asked-about, or every status read of that account fires another outbound
  // call. It must not touch state while doing that.
  it('moves only the attempt clock, never the entitlement', async () => {
    await repo.upsertFromProvider(event('sub_attempt', { status: 'active' }));
    const before = await read('sub_attempt');

    await repo.markSyncAttempt('paddle', 'sub_attempt', before.lastSyncedAt + 60_000);

    const after = await read('sub_attempt');
    expect(after.lastSyncedAt).toBe(before.lastSyncedAt + 60_000);
    expect({ ...after, lastSyncedAt: 0 }).toEqual({ ...before, lastSyncedAt: 0 });
  });

  it('is a no-op for a row that does not exist', async () => {
    await expect(repo.markSyncAttempt('paddle', 'sub_absent')).resolves.toBeUndefined();
  });
});

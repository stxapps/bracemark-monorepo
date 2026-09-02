// Per-user storage quota, enforced at `POST /v1/files/sign` (op: 'put') — the one
// place abuse can be bounded when content is opaque (the server can't inspect a
// blob, only count and size it). Checked against the durable per-path size map in
// the user's DO (do/repositories/file-sizes.ts), never the disposable op log. See
// docs/local-first-sync.md "authorization & quota".
//
// THIS IS A COST BACKSTOP, NOT A PRODUCT GATE. It answers exactly one question —
// is this account writing more than we are willing to store for it — with one
// error code, `quota_exceeded` (403), which the client maps to "storage full".
// The limits come from the shared `entitlementsOf()` table (iap/plans.ts),
// resolved per request by services/iap.ts.
//
// THE CEILINGS ARE NOT RETROACTIVE. services/iap.ts resolves them from the
// account's HIGH-WATER plan — the best plan it has ever held — not the plan it
// holds today (foldQuotaCeilings). Every other entitlement snaps back to `free`
// the moment a subscription lapses; these two do not, because a backstop sized
// for what we are willing to STORE should never turn data we already accepted
// into data the owner cannot edit. Any account whose library outgrew the free
// ceilings while it was entitled — a canceled subscriber, or a trial that
// imported a switcher's library and then ended — would otherwise wake up the
// day after in a state where every put is refused: no retitle, no retag, and
// not even move-to-Trash (a `links/` put), leaving permanent irreversible
// delete as the only route back under. Note how little of that is about cost:
// the R2 bill for those blobs is the same whether or not we let their owner
// rename one, and deleting is always free. `maxLinks` is the gate that carries
// the downgrade, and it still snaps back.
//
// This opens no abuse surface, which is the whole reason it can be this simple.
// A raised ceiling requires a purchase row, a purchase row requires a completed
// Paddle/store checkout, and a checkout requires a payment method — the exact
// cost that makes account-farming uneconomic. An abuser willing to spend a real
// card per account was never who 100 MiB was defending against.
//
// The free tier's 200-link cap is NOT here, deliberately. It used to be: the
// gate counted `links/` paths and answered `upgrade_required`, which meant it
// also had to tell a CREATE from an in-place UPDATE (an account at its cap must
// still be able to retitle and trash what it owns), which meant an existence
// check against the size map on every sign batch, a partial-push retry in the
// sync engine, and a whole sync state for "some of your changes were refused".
// The cap is now enforced by the create surfaces themselves (web-react
// use-link-quota, the import gate, the share sheet's isAtLinkCap). The two gates
// defend different things — a link-cap bypass costs a few hundred KB and is
// bounded by maxBytes below, while the byte ceiling is the only thing standing
// between one scripted client and an unbounded R2 bill, so it stays server-hard
// and the cheap one went honor-system.
//
// Both checks read CURRENT usage and ignore what the batch is about to add. That
// is the same conservatism the byte check always had (a new object's size is
// unknown until it's uploaded, so growth is charged on the NEXT batch), and it is
// what lets this gate stop caring about create-vs-update: charging an in-place
// update against a ceiling only matters if accounts sit at the ceiling, and
// nobody legitimately sits at 5 000 files / 100 MB (free) or 1 000 000 / 5 GB
// (paid). The 200-link cap was the opposite case — a limit every free account is
// DESIGNED to live at — which is precisely why it needed the distinction and why
// it doesn't belong in a backstop. The high-water rule above is what keeps that
// premise true: the one population that DID legitimately sit at a ceiling was
// the downgraded account, whose library was sized under a plan it no longer has.
//
// Puts are the ONLY gated op. GETs are reading your own data, and deletes ride
// ops/commit ungated — so an over-quota account (e.g. after a downgrade) is
// read-only-plus-delete, never data-loss or lock-out.

import type { Entitlements } from '@stxapps/shared';

import type { FileUsage } from '../do/user-data';
import { HttpError } from './errors';

// The two numbers this gate enforces, and deliberately NOT the whole
// `Entitlements` object: they are resolved from a different plan than every
// other field (the high-water one, above), so a mixed object would be a trap for
// anything that read a feature flag off it. Narrowing the parameter makes that
// structurally impossible — there is nothing here to misread.
export type QuotaCeilings = Pick<Entitlements, 'maxFiles' | 'maxBytes'>;

// Gate one `files/sign` put batch against what the account is already storing.
export function checkPutQuota(ceilings: QuotaCeilings, usage: FileUsage): void {
  if (usage.fileCount >= ceilings.maxFiles) {
    throw new HttpError(403, 'quota_exceeded', 'File-count quota exceeded');
  }
  if (usage.totalBytes >= ceilings.maxBytes) {
    throw new HttpError(403, 'quota_exceeded', 'Storage quota exceeded');
  }
}

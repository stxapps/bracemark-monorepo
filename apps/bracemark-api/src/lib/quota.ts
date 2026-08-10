// Per-user storage quota, enforced at `POST /v1/files/sign` (op: 'put') — the one
// place abuse can be bounded when content is opaque (the server can't inspect a
// blob, only count and size it). Checked against the durable per-path size map in
// the user's DO (do/repositories/file-sizes.ts), never the disposable op log. See
// docs/local-first-sync.md "authorization & quota".
//
// THIS IS A COST BACKSTOP, NOT A PRODUCT GATE. It answers exactly one question —
// is this account writing more than we are willing to store for it — with one
// error code, `quota_exceeded` (403), which the client maps to "storage full".
// The limits come from the account's plan via the shared `entitlementsOf()`
// (iap/plans.ts), resolved per request by services/iap.ts.
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
// nobody legitimately sits at 5 000 files / 100 MB (free) or 200 000 / 5 GB
// (paid). The 200-link cap was the opposite case — a limit every free account is
// DESIGNED to live at — which is precisely why it needed the distinction and why
// it doesn't belong in a backstop.
//
// Puts are the ONLY gated op. GETs are reading your own data, and deletes ride
// ops/commit ungated — so an over-quota account (e.g. after a downgrade) is
// read-only-plus-delete, never data-loss or lock-out.

import type { Entitlements } from '@stxapps/shared';

import type { FileUsage } from '../do/user-data';
import { HttpError } from './errors';

// Gate one `files/sign` put batch against what the account is already storing.
export function checkPutQuota(ent: Entitlements, usage: FileUsage): void {
  if (usage.fileCount >= ent.maxFiles) {
    throw new HttpError(403, 'quota_exceeded', 'File-count quota exceeded');
  }
  if (usage.totalBytes >= ent.maxBytes) {
    throw new HttpError(403, 'quota_exceeded', 'Storage quota exceeded');
  }
}

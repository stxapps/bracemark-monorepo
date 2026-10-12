import { API_V1, defineEndpoint } from '../api/endpoint';
import { usernameSchema } from '../auth/credentials';
import { z } from '../zod';

// Data-lifecycle endpoint contracts — the destructive, whole-namespace actions
// that sit BESIDE the four-endpoint sync control plane (sync/endpoints.ts), not
// in it: sync moves individual paths; these operate on everything the user has
// at once. See docs/data-lifecycle.md.

// --- POST /v1/data/delete-all — wipe every synced object ---------------------

// Server-side wipe of the caller's whole data namespace: the per-user op log +
// quota map (the Durable Object) and every R2 object under the user's prefix.
// Server-side rather than a client-enumerated delete loop because only the
// server sees the whole prefix — a client can only delete what it knows about,
// so orphans (object-without-op leftovers, blobs another device pushed but this
// one never pulled) would survive a client-driven wipe. The account, sessions,
// and subscription are untouched — this deletes the bytes, not the identity.
//
// Other devices converge with NO new sync machinery: the wiped op log answers
// their next pull with null bounds, which routes them into the download-
// authoritative fallback against the now-empty R2 listing (see the routing
// table in docs/local-first-sync.md — "the ops/list endpoint").
//
// One request field, and it is not what picks the namespace: that is still the
// authenticated user's (the bearer token names it — the server never takes a
// user id from a body). `username` is the account the caller MEANS, and the
// server wipes only when the token's account is that one, answering 409
// `account_mismatch` otherwise with nothing touched.
//
// The token alone can't say that. A client attaches whichever session is current
// when the request LEAVES, and the flow that sends this one decided to delete
// for the account on screen at the click — then waits on an in-flight sync
// before it sends, long enough for the account to change under it (on web
// another tab signs in as someone else and this one adopts the session in
// place). Unbound, that request carries the NEXT account's token and empties its
// namespace, irreversibly, on a confirmation the previous account gave. So the
// name travels with the request and the check sits where the wipe is — not in
// the client, where "compare, then send" is only safe while nothing between the
// two ever awaits. docs/data-lifecycle.md, _delete all data_.
export const dataDeleteAllRequestSchema = z.object({
  username: usernameSchema,
});
export type DataDeleteAllRequest = z.infer<typeof dataDeleteAllRequestSchema>;

// The one code of its own this endpoint answers (409): the token's account is
// not the one the body names. Clients branch on the CODE, never the status
// (`apiErrorCode`, api/client.ts).
export const DATA_DELETE_ALL_ERROR = {
  accountMismatch: 'account_mismatch',
} as const;

// `deletedCount` is the number of R2 objects removed — the receipt line the
// settings UI shows. 0 is a valid outcome (nothing stored), not an error.
export const dataDeleteAllResponseSchema = z.object({
  deletedCount: z.number().int().min(0),
});
export type DataDeleteAllResponse = z.infer<typeof dataDeleteAllResponseSchema>;

// POST /v1/data/delete-all → { deletedCount }
// Idempotent: re-running against an already-empty namespace deletes 0 and
// succeeds, so the client's retry after a failure is just "call it again".
//
// Its own deadline: R2 has no delete-by-prefix, so the server pages list +
// bulk-delete 1000 keys at a time, one after another, and answers only when the
// last page is gone. The time grows with the account's object count, not the
// request — a large library is hundreds of subrequests before the first
// response byte. The default deadline would report a failure for a wipe that is
// still running.
export const DELETE_ALL_TIMEOUT_MS = 5 * 60_000;

export const dataDeleteAllEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/data/delete-all`,
  request: dataDeleteAllRequestSchema,
  response: dataDeleteAllResponseSchema,
  timeoutMs: DELETE_ALL_TIMEOUT_MS,
});

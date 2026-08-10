import { z } from 'zod';

import { API_V1, defineEndpoint } from '../api/endpoint';

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
// No request fields: the namespace to wipe is the authenticated user's (the
// bearer token names it), so the body is empty. An object schema (rather than
// nothing) keeps the contract uniform — the client still sends `{}` as JSON.
export const dataDeleteAllRequestSchema = z.object({});
export type DataDeleteAllRequest = z.infer<typeof dataDeleteAllRequestSchema>;

// `deletedCount` is the number of R2 objects removed — the receipt line the
// settings UI shows. 0 is a valid outcome (nothing stored), not an error.
export const dataDeleteAllResponseSchema = z.object({
  deletedCount: z.number().int().min(0),
});
export type DataDeleteAllResponse = z.infer<typeof dataDeleteAllResponseSchema>;

// POST /v1/data/delete-all → { deletedCount }
// Idempotent: re-running against an already-empty namespace deletes 0 and
// succeeds, so the client's retry after a failure is just "call it again".
export const dataDeleteAllEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/data/delete-all`,
  request: dataDeleteAllRequestSchema,
  response: dataDeleteAllResponseSchema,
});

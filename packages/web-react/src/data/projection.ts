'use client';

// The one place that turns a decrypted blob into an `ItemRecord` — both the
// payload-agnostic bytes (`id`/`updatedAt`/`data`) AND the `item*` query columns
// the indexes are built on (db.ts). EVERY write into `db.items` of a path that
// carries a payload must go through `toItemRecord`, so the projected columns are
// written in the SAME `put` as the bytes they describe and can never drift from
// them — that's what lets us index in-blob fields without a second table or a
// cross-table transaction.
//
// This is the deliberate seam where the local store stops being payload-blind:
// the wire/crypto path (engine.ts, r2.ts) still moves opaque ciphertext and never
// imports a schema — it just hands (path, updatedAt, bytes) here. Schema
// knowledge lives ONLY in this module and the read layer (data.ts), which share
// the same `parseBlob` so a record is decoded by identical rules wherever it's
// read.

import { z } from 'zod';

import {
  bytesToUtf8,
  canonicalUrlKey,
  EXTRACTIONS_PREFIX,
  extractionSchema,
  FILES_PREFIX,
  LINKS_PREFIX,
  linkSchema,
  LISTS_PREFIX,
  PINS_PREFIX,
  SETTINGS_PREFIX,
  TAGS_PREFIX,
} from '@stxapps/shared';

import type { ItemRecord, ItemType } from './db';

// Every synced entity carries an `updatedAt` (entities.ts) — and that's all the
// projector needs from a non-link record to make it orderable. Decoding against
// this concern-agnostic shape instead of a per-type schema means a NEW settings
// concern (`settings/<concern>.enc` beyond `general`), or any future list/tag
// field, projects correctly with no branch here — and the projector doesn't have
// to import every entity schema just to read one field.
const timestampedSchema = z.looseObject({
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

// Decode raw blob bytes against a schema, or `undefined` if absent/unparseable.
// `undefined` data is a `files/` content record not yet lazily downloaded (db.ts);
// a parse/validate miss is a forward-incompatible shape from a newer client — the
// read layer drops it from a view rather than crashing. `looseObject` schemas
// keep unknown fields, so a decoded entity still round-trips on re-encrypt.
export function parseBlob<T extends z.ZodTypeAny>(
  data: Uint8Array | undefined,
  schema: T,
): z.infer<T> | undefined {
  if (!data) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(bytesToUtf8(data)));
    return parsed.success ? (parsed.data as z.infer<T>) : undefined;
  } catch {
    return undefined;
  }
}

// The path's namespace prefix → its `itemType`. `undefined` for an unknown
// prefix (forward-compat: a namespace this client version doesn't model yet).
export function itemTypeForPath(path: string): ItemType | undefined {
  if (path.startsWith(LINKS_PREFIX)) return 'link';
  if (path.startsWith(LISTS_PREFIX)) return 'list';
  if (path.startsWith(TAGS_PREFIX)) return 'tag';
  if (path.startsWith(PINS_PREFIX)) return 'pin';
  if (path.startsWith(EXTRACTIONS_PREFIX)) return 'extraction';
  if (path.startsWith(SETTINGS_PREFIX)) return 'setting';
  if (path.startsWith(FILES_PREFIX)) return 'file';
  return undefined;
}

// Build the stored `ItemRecord` for one path: sync fields plus the projected
// query columns decoded from `data`. A blob-less record (lazy `files/` content),
// a `files/` content path (no list-view payload), or an unknown namespace
// projects no `item*` columns beyond `itemType` — so it simply doesn't appear in
// the link-view indexes. A typed index record that fails to parse still stores
// its bytes and `itemType`; it's just absent from the value-based indexes until a
// future client understands it.
export function toItemRecord(path: string, updatedAt: number, data?: Uint8Array): ItemRecord {
  const itemType = itemTypeForPath(path);
  const record: ItemRecord = { path, updatedAt, data, itemType };
  if (!data || itemType === undefined || itemType === 'file') return record;

  if (itemType === 'link') {
    const link = parseBlob(data, linkSchema);
    if (link) {
      record.itemCreatedAt = link.createdAt;
      record.itemUpdatedAt = link.updatedAt;
      // itemListId / itemTagIds are set HERE ONLY (links). That exclusivity is
      // load-bearing: the `[itemListId+…]` and `*itemTagIds` indexes (db.ts) are
      // link-scoped for FREE precisely because no other type fills these columns,
      // so queries.ts's readLinks treats those indexes as "links only". If a
      // future itemType ever projects itemListId/itemTagIds too, those indexes
      // start mixing types — you must then add an `itemType` discriminator to them
      // (e.g. `[itemType+itemListId+…]`) and update readLinks, or it returns
      // non-link rows. (The all-type `[itemType+item*At]` indexes don't have this
      // problem — itemType already scopes them.)
      record.itemListId = link.listId;
      record.itemTagIds = link.tagIds;
      record.itemUrl = link.url;
      // The client-only dedup identity (db.ts `itemUrlKey`): DERIVED here, never
      // read from the blob, so the key rules can evolve without touching synced
      // state. null (confirm-saved raw text) projects no key — sparse index.
      record.itemUrlKey = canonicalUrlKey(link.url) ?? undefined;
    }
    return record;
  }

  // Extractions are the one non-link type with a churny, indexable INNER shape, so
  // they get the only other type-aware branch. `extractions/{id}.enc` shadows a link
  // one-to-one, so the namespace grows with the library — reading them all to tally
  // facet status (the options page) would be O(library). Instead project each facet's
  // `${status}:${facet}` into a multiEntry column (`*itemFacetStatuses`, db.ts): one
  // index entry per facet lets the done/failed/permanent counts come from
  // `equals('done:titleImage')`-style range-counts (readExtractionFacetCounts) — no
  // scan, no decode. There is no `pending` status (entities.ts): pending = ABSENCE (no
  // facet entry, often no extractions file at all), so the work loop / pending count is
  // a set difference (links minus the recorded outcomes), not an index token. This is
  // the only place the projector reads an entity's internal structure beyond `links`.
  if (itemType === 'extraction') {
    const extraction = parseBlob(data, extractionSchema);
    if (extraction) {
      record.itemCreatedAt = extraction.createdAt;
      record.itemUpdatedAt = extraction.updatedAt;
      const statuses: string[] = [];
      for (const [facet, state] of Object.entries(extraction.facets)) {
        if (state?.status) statuses.push(`${state.status}:${facet}`);
      }
      record.itemFacetStatuses = statuses;
    }
    return record;
  }

  // lists, tags, pins, and EVERY settings concern: only the edit time
  // is worth indexing (their views are small, prefix-scanned/exact-path reads — see queries.ts —
  // but the column keeps the projector uniform and leaves them orderable for
  // free). Decoded concern-agnostically, so this never assumes a settings file is
  // `general`.
  const entity = parseBlob(data, timestampedSchema);
  if (entity) {
    record.itemCreatedAt = entity.createdAt;
    record.itemUpdatedAt = entity.updatedAt;
  }
  return record;
}

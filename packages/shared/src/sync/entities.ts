import { z } from '../zod';

// Plaintext entity shapes — what's INSIDE the ciphertext of each synced file
// (see docs/local-first-sync.md "data model" + "plaintext typing"). These are a
// cross-platform contract like the blob wire format: every platform encrypts and
// decrypts the same JSON, so the shapes live here in `shared`, not in any app.
//
// Unlike the endpoint contracts next door (endpoints.ts), NOTHING here ever
// crosses the wire in plaintext — the server never sees these fields. The
// schemas exist for the CLIENT read layer: parse a decrypted item's bytes into a
// typed entity before handing it to the UI.
//
// Every object is `z.looseObject` — unknown fields pass through — on purpose.
// Devices upgrade at different times: a newer client may add a field, and an
// older client that parses, edits, re-encrypts, and re-uploads the file must
// ROUND-TRIP that unknown field, not silently strip it (a strict schema would
// make every old-client edit destroy new-client data). For the same reason,
// never repurpose or re-type an existing field — add a new one.
//
// Timestamps are epoch milliseconds, the convention everywhere else in the sync
// system. The `updatedAt` here is the USER-MEANINGFUL edit time, written inside
// the ciphertext by the editing client — distinct from the server-side R2
// `LastModified` that drives sync ordering (an ItemRecord/op-log `updatedAt`),
// which is infrastructure the plaintext doesn't depend on.

// The plaintext of `links/{id}.enc` — the USER-AUTHORED half of one link. Small by
// design (< ~2 KB budget): list-view fields only, so the whole library is browsable
// offline after first sync. The machine-derived half (the extracted title/image, the
// page-copy/screenshot refs, the extraction bookkeeping) lives in `extractions/{id}.enc`
// — split BY WRITER so a background extractor never read-merge-writes this file and so
// can never clobber a concurrent user edit under LWW (see docs/link-extraction.md "the
// data model"). Heavy media itself (page-copy/screenshot/preview bytes, long notes) lives
// in separate `files/{id}.enc` blobs referenced by id — never inlined. `listId`/`tagIds`
// hold ids of `lists/{id}.enc` / `tags/{id}.enc` files; a dangling id (tag deleted on
// another device) is NORMAL and the UI skips it, never errors.
//
// Reference fields end in `Id`/`Ids` and store the BARE entity id, never a full
// path: the `{namespace}` prefix + `.enc` suffix is applied at the read edge
// (paths.ts), the same convention the link's own `links/{id}.enc` path follows.
// Char caps for the inline, user-/extraction-written text fields — the single
// source of truth the input edge, the extractor, and this schema all share, so the
// limit can't drift between where it's enforced and where it's validated. They
// protect the `< ~2 KB` metadata budget (see local-first-sync.md "metadata vs
// content"); counts are UTF-16 length, so worst-case multi-byte text stays bounded.
// Keep them GENEROUS: because these schemas parse persisted bytes, a value over the
// cap fails to parse and drops the record from the UI (the link for `customTitle`/
// `note`, the extraction for its `title`) — so the cap must never trip a legitimate
// value, and writers (the editor, the extractor truncating og:title) enforce the same
// number up front. The same `LINK_TITLE_MAX` is shared by `customTitle` and
// `extractionSchema.title` so a title can't be valid in one file but not the other.
// `url` is deliberately NOT capped: it
// is the link's identity, so truncating it would corrupt the link — the per-user
// byte quota is its only backstop.
export const LINK_TITLE_MAX = 300; // shared by `linkSchema.customTitle` + `extractionSchema.title` (a title either way)
export const LINK_NOTE_MAX = 500; // short inline note; long-form → files/ (`noteId`)

// Caps the WRITERS hold a list's and a tag's name to — the editors (through the
// mutation hooks) and an import (import/resolve.ts) — and that the schemas below
// deliberately do NOT carry. A name was never capped, so a longer stored one is
// legitimate data, and a cap in `listSchema` would drop that list from every view
// and file its links under My List. Generous for the same reason as the caps
// above: a name past it is cut, never refused (docs/data-limits.md).
export const LIST_NAME_MAX = 200;
export const TAG_NAME_MAX = 200;

// The most tags an import gives one link (import/resolve.ts, TagResolver) —
// the file's first ones, in its order. `tagIds` is inline in the link's
// `< ~2 KB` metadata, and a file can name any number per row; no editor comes
// near it by hand, so they aren't gated. Not in `linkSchema`, for the reason the
// names aren't.
export const LINK_TAGS_MAX = 100;

// A list or tag name as a writer stores it: trimmed, then cut to `max`.
export function cleanName(raw: string, max: number): string {
  return raw.trim().slice(0, max).trimEnd();
}

export const linkSchema = z.looseObject({
  // Uncapped on purpose — the link's identity must never be truncated (see the
  // `LINK_TITLE_MAX` note above); the per-user byte quota is the only backstop.
  url: z.string(),
  // List id (the `{id}` of `lists/{id}.enc`).
  listId: z.string(),
  // Tag ids (the `{id}` of `tags/{id}.enc`). Order is the user's tag order.
  tagIds: z.array(z.string()),
  // The user's DELIBERATE title/image override. The UI resolves the displayed title as
  // `customTitle ?? extraction.title ?? host(url)` and the image as
  // `customImageId ?? extraction.imageId`, so a manual edit always wins over the
  // extracted/discovered value (which lives in `extractions/{id}.enc`). Because the two
  // writers now own SEPARATE FILES — the user this one, extraction the extractions file
  // — re-running or tier-upgrading extraction can't touch these at all, and clearing
  // one reverts to the still-present extracted value. A title the user types AT SAVE is
  // deliberate too, so it lands here. (A title that merely RODE IN from a bulk import is
  // NOT deliberate — it seeds the provisional `extraction.title`, which extraction may
  // still upgrade — see docs/link-extraction.md.) `customImageId` is a `files/{id}.enc`
  // ref to a user-picked image, the same heavy-media rule as `extraction.imageId`.
  //
  // These live here in `links/` — one file, one user gesture, beside `listId`/`tagIds`
  // — NOT a separate entity/file. A manual override is a low-frequency USER edit, the
  // opposite of the churny automated state that earns `pins/` and `extractions/` their
  // own LWW-isolated files; a shadow override file would only force a single edit to
  // write two files and race under LWW.
  customTitle: z.string().max(LINK_TITLE_MAX).optional(),
  customImageId: z.string().optional(),
  // The user's own free-text note on the link — their annotation, NOT the page's
  // extracted description/summary (that's the extraction `summary` facet; a field
  // named `note` is always the user's words). Kept INLINE so it shows in the list
  // view and stays searchable offline like `customTitle`/`url` — and therefore CAPPED to
  // protect the `< ~2 KB` metadata budget (see local-first-sync.md "metadata vs
  // content"). The cap counts UTF-16 length, so worst-case multi-byte text still
  // stays bounded. Long-form multi-paragraph notes do NOT belong here — those are a
  // separate `files/{id}.enc` blob (a `noteId` ref, deferred), the same lazy
  // heavy-field rule as page copies/screenshots.
  note: z.string().max(LINK_NOTE_MAX).optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Link = z.infer<typeof linkSchema>;

// The plaintext of `lists/{id}.enc` / `tags/{id}.enc`. One small file per
// list/tag is what lets two devices rename two DIFFERENT tags concurrently under
// file-level LWW. `id` repeats the path's id so the plaintext is self-contained.
// `parentId`/`rank` give lists and tags a tree: `parentId` is the BARE id of the
// parent entity (its `{id}` in `lists/`|`tags/`), or `null` at the root — never
// `undefined`, so "top-level" is an explicit value a concurrent edit can't be
// confused about. A dangling/cyclic/forbidden parent is reconciled at read time
// (buildTree promotes it to root), exactly like a dangling reference elsewhere.
//
// `rank` is a fractional-index key (see sync/rank.ts) ordering an entity among
// its siblings. It's a STRING, not an index, on purpose: under file-level LWW
// moving one entity must write only that one file — `rank = keyBetween(a, b)`
// inserts between two neighbours without touching them, so concurrent reorders of
// different entities never collide. (Two neighbours CAN hold equal keys — two
// devices inserting at one slot — and a move between them re-keys one of the
// pair as well: `placeAtIndex`, rank.ts.) Required (no legacy entities to back-fill);
// the system-list defaults seed real keys (system-lists.ts) so user entities can
// rank against them.
export const listSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  rank: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type List = z.infer<typeof listSchema>;

export const tagSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  rank: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Tag = z.infer<typeof tagSchema>;

// The plaintext of `pins/{id}.enc` — marks a link as pinned ("pin to the top").
// One file per pinned link, with `id` repeating the link's id (the `{id}` of its
// `links/{id}.enc`), so a pin is self-contained AND its own last-writer-wins point:
// pinning, unpinning, or reordering writes ONLY this file, so it never clobbers a
// concurrent edit to the link's blob (title/list/tags) — the same isolation
// reasoning that gives lists/tags one file each. A flag inside `linkSchema` would
// instead make every pin/reorder rewrite the link and collide under LWW.
//
// `rank` is the fractional-index key (sync/rank.ts) ordering the pinned links
// among THEMSELVES — the user's manual pin order, independent of any view's sort.
// Deliberately NO `listId`: the link already records its list, so a pin needs no
// list scoping and survives the link moving lists untouched. A pin whose link is
// gone (deleted on another device) is a dangling reference the read layer skips,
// exactly like a dangling `listId`/`tagId`.
export const pinSchema = z.looseObject({
  id: z.string(),
  rank: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Pin = z.infer<typeof pinSchema>;

// The plaintext of `extractions/{id}.enc` — EVERYTHING a machine derives about a link,
// with `id` repeating the link's id (the `{id}` of its `links/{id}.enc`), so it's
// self-contained AND its own last-writer-wins point. This is the MACHINE-WRITTEN half
// of a link; `links/{id}.enc` is the USER-WRITTEN half. The split is by WRITER, which
// is the property that matters: extraction writes only THIS file, so it can never
// read-merge-write the user's file and clobber a concurrent list/tag/title edit under
// LWW — the one unrecoverable race the old "display result in links/" layout risked. It
// carries two kinds of machine state, both written by the SAME writer (the extractor),
// so LWW races between them are self-healing (re-extract is idempotent):
//   1. the DISPLAY RESULT — `title` (the discovered/provisional og:title), `imageId`
//      (og:image preview), `pageCopyId`, `screenshotId` (heavy `files/{id}.enc`
//      refs). The UI resolves `customTitle ?? title ?? host(url)` and
//      `customImageId ?? imageId` (the `custom*` halves live in `linkSchema`).
//   2. the BOOKKEEPING — the per-facet who/when/quality/retry map (`facets`).
// A bulk import seeds the provisional `title` here only with what the SOURCE's own
// extractor found (Brace); a title an interop file carries goes in `customTitle`, since
// the file can't say whether the user renamed it (import/bundle.ts). Written by
// client extractors (the extension, future Expo app, the web app orchestrating
// bracemark-extractor or an import), NEVER by `bracemark-api`, which stays a blind sync broker.
// The work loop is a QUERY, not a queue object: a link with no `done` `titleImage`
// facet (no extractions file at all, or one not yet extracted) is pending. See
// docs/link-extraction.md.
//
// A link is NOT one extraction with one lifecycle: title+image, read-mode, screenshot,
// page copy, keywords, tags, summary, and (deferred) vectors are INDEPENDENT jobs — each
// produced by a different client/tier at a different time, each able to be missing while
// another is `done`. So the entity carries a MAP of facet → state (`facets`), not a flat
// `status`. One flat file per link with the facets inside (not one prefix per facet): a
// per-facet split would multiply objects ~8× and only guard a rare, self-healing race —
// see the doc's "path layout" note.

// One facet's state — the who/when/quality/retry questions answered independently per
// job. `z.looseObject` so a newer client adding a field round-trips through older ones
// (the file-wide rule above).
export const facetSchema = z.looseObject({
  // No `pending`: a facet no client has touched simply has NO entry (and a link with no
  // extractions file has none at all) — absence IS pending. `done` = success; `failed` =
  // transient, retry once `now >= extractedAt + backoff(attempts)`; `permanent` = hard
  // failure (404/410, robots block), never retry. Because this is SYNCED, one device's
  // `permanent`/`failed` stops every device retrying.
  status: z.enum(['done', 'failed', 'permanent']),
  // WHO ran the last attempt — a `platform:env` string (`extension:fg`, `expo:fg`,
  // `expo:bg`, `server`), NOT a device id: nothing reads this for identity
  // (there's no claim lease and no per-device coordination — see below), only for
  // QUALITY. (The extension is active-context only, so it emits `:fg` only — never an
  // `extension:bg`; the `:bg` tier comes from Expo background / `bracemark-extractor`. See
  // docs/link-extraction.md "the extension is active-context only".)
  // Quality (the upgrade axis) is DERIVED from it by the shared `tierOf()` helper
  // — `:fg` → active-page beats `:bg` → bg-fetch beats `server` — so a client whose
  // derived tier beats a `done` facet's may re-extract to UPGRADE it. There is no stored
  // `tier` field: it's a pure function of `extractedBy`, and a derived value sitting
  // beside its input is the same drift-prone two-field invariant we avoid with
  // `nextEligibleAt` below. Kept a `z.string()` (not an enum) so a future platform/env a
  // newer client emits round-trips through older ones (the file-wide rule) instead of
  // failing to parse; `tierOf()` ranks an unrecognized value conservatively low so it
  // never wrongly out-ranks a known active-page result.
  extractedBy: z.string().optional(),
  extractedAt: z.number().int().optional(), // when — success time when done, last try when failed
  attempts: z.number().int(), // backoff counter — retry when now >= extractedAt + backoff(attempts)
  // No claim lease (`claimedBy`/`claimedAt`): a rare double-extraction is resolved by
  // idempotency + file-level LWW, not prevented by a synced lease (which would force an
  // extra round-trip on the critical path yet stay best-effort anyway). No
  // `nextEligibleAt` either — it's derived from `extractedAt` + `attempts` via the shared
  // `backoff()` curve. See docs/link-extraction.md "the extraction entity".
});
export type Facet = z.infer<typeof facetSchema>;

// A link carries only the facets some client has finished — `titleImage` done while
// `screenshot` is still missing, etc. — so `facets` is a PARTIAL record: a missing facet
// key means "no client has done this job yet" = pending. `z.partialRecord`, not
// `z.record`, because the latter over an enum key infers an EXHAUSTIVE `Record` (all 8
// required) — which neither matches reality nor parses a real one-facet extraction. The
// display fields are the results of specific facets: `title`/`imageId` from `titleImage`,
// `pageCopyId` from `pageCopy`, `screenshotId` from `screenshot`; each is absent until
// its facet lands. All but the inline `title` are `files/{id}.enc` refs — "a field name
// types its blob" (see docs/local-first-sync.md "plaintext typing").
export const extractionSchema = z.looseObject({
  id: z.string(), // = the link's id (the `{id}` of `links/{id}.enc`)
  // The discovered/provisional title (og:title, or a bulk-imported title meanwhile),
  // capped like `customTitle` (shared LINK_TITLE_MAX). The UI shows
  // `customTitle ?? title ?? host(url)`, so this is the fallback below a user override.
  title: z.string().max(LINK_TITLE_MAX).optional(),
  // The page's og:image / lead-image preview — a `files/{id}.enc` ref, downloaded and
  // encrypted by the extracting client, NEVER the remote URL (see the doc's "the preview
  // image is a downloaded blob"). Shown as `customImageId ?? imageId`.
  imageId: z.string().optional(),
  // The saved copy of the page's content (`files/{id}.enc`), from the `pageCopy` facet.
  // Named "page copy", never "archive": `archive` is the ARCHIVE_ID system list (a link
  // filed away), an unrelated concept — see sync/system-lists.ts.
  pageCopyId: z.string().optional(),
  // The full-page screenshot (`files/{id}.enc`), from the `screenshot` facet — a rendered
  // capture, distinct from the og:image `imageId`. Active-page tier only (the extension's
  // `tabs.captureVisibleTab`).
  screenshotId: z.string().optional(),
  facets: z.partialRecord(
    z.enum([
      'titleImage',
      'readMode',
      'screenshot',
      'pageCopy',
      'keywords',
      'tags',
      'summary',
      'vectors',
    ]),
    facetSchema,
  ),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Extraction = z.infer<typeof extractionSchema>;

// The shared extraction WRITER helpers — `cleanTitle()` (normalize a title to the
// `LINK_TITLE_MAX` cap above), `tierOf()` (quality rank from `extractedBy`), and
// `backoff()` (retry pacing from `attempts`/`extractedAt`) — operate on the fields in
// this file, but live in sync/extraction.ts: this file is the plaintext SHAPE
// contract; those are BEHAVIOR (the rank.ts/tree.ts split).

// How the links library lays out its rows: `list` (dense default) and `card` (a
// grid of previews). A cross-platform contract — not a web-only union — because
// the user's choice can be SYNCED (see `settingsGeneralSchema` below), so every
// client must read/write the same string values.
//
// This is the WRITER's enumeration: what a UI offers and what a client may store.
// It is deliberately NOT what the read edge validates against — a persisted
// `linksLayout` is parsed as a free `z.string()` (see `settingsGeneralSchema`), so
// a value this client doesn't model round-trips instead of being dropped or
// clobbered. That asymmetry is what lets this list GROW without a migration: a
// future `table` layout is added
// here, and clients that predate it keep syncing happily, rendering their default
// and leaving the unknown value untouched.
export const LINKS_LAYOUTS = ['list', 'card'] as const;
export type LinksLayout = (typeof LINKS_LAYOUTS)[number];

// How the links library is ORDERED — a synced account preference (see
// `settingsGeneralSchema`'s `sortOn`/`sortOrder` below), split into two orthogonal
// axes so each round-trips and defaults independently under the file's looseObject
// rule: `sortOn` is the field (date modified vs. date added), `sortOrder` the
// direction. Both are the WRITER's enumerations — what a UI offers and a client may
// store — NOT what the read edge validates against (the persisted values parse as
// free `z.string()`, exactly like `linksLayout`, so a value a newer client stores
// round-trips instead of dropping the settings blob). The read side coerces an
// unknown/absent value back to a known one with the helpers below.
export const LINK_SORT_ONS = ['updatedAt', 'createdAt'] as const;
export type LinkSortOn = (typeof LINK_SORT_ONS)[number];

export const LINK_SORT_ORDERS = ['asc', 'desc'] as const;
export type LinkSortOrder = (typeof LINK_SORT_ORDERS)[number];

// Narrow a PERSISTED sort value (a free `string`/`undefined` off the tolerant read
// schema) to a known enum member, falling back to the default — the read edge's
// counterpart of the writer enums above. The default matches `emptyQuery` in the
// web read layer: newest-modified-first. Without this, an unknown future value would
// index the sort tables to `undefined` and crash the read; with it, the unknown value
// still round-trips at the storage layer (looseObject) while rendering falls back.
export function coerceLinkSortOn(value: string | undefined): LinkSortOn {
  return LINK_SORT_ONS.includes(value as LinkSortOn) ? (value as LinkSortOn) : 'updatedAt';
}

export function coerceLinkSortOrder(value: string | undefined): LinkSortOrder {
  return LINK_SORT_ORDERS.includes(value as LinkSortOrder) ? (value as LinkSortOrder) : 'desc';
}

// How much ON-DEVICE link extraction the account permits — the `deviceExtractionMode`
// field below, as ONE AXIS OF INCREASING DISCLOSURE rather than a boolean:
//
//   off   — this device never contacts a site you save. Nothing is fetched: no page,
//           no preview image, no favicon, not even for a link saved right here. The
//           position that exists because the rest of the product is built for the user
//           who chose an E2E app precisely so no one sees their library; "we always
//           fetch the pages you save, and you can't stop us" is the one place that
//           promise would have had a hole. Links still save, sync, and read fine —
//           they just show `host(url)` and a monogram (both steady states by design).
//   saves — THE DEFAULT, and exactly the old boolean's `false`: a link saved ON THIS
//           DEVICE is extracted (the save is the gesture — docs/link-extraction.md,
//           _the stance_), a link that arrived by sync or import is not.
//   all   — the old boolean's `true`: also back-fill the residual, un-gestured.
//
// It replaced the `deviceExtraction` boolean outright (before the first release — no migration, and
// `looseObject` round-trips the dead field harmlessly on any device that still holds
// one). The two positions the boolean could express keep their exact meanings, so the
// only NEW behavior is `off`.
//
// Like `linksLayout`/`sortOn`, this is the WRITER's enumeration: the persisted value
// parses as a free `z.string()` so a mode added later round-trips on an older client
// instead of dropping the settings blob, and the read edge narrows it with
// `coerceDeviceExtractionMode`. Unlike those, the fallback here is load-bearing rather
// than cosmetic — an unrecognized value must land on a position that is no more
// permissive than the user chose, and `saves` is the floor every client already
// implements. A future stricter mode would therefore need care: it must be added as a
// value old clients coerce DOWN to, or gated some other way.
export const DEVICE_EXTRACTION_MODES = ['off', 'saves', 'all'] as const;
export type DeviceExtractionMode = (typeof DEVICE_EXTRACTION_MODES)[number];

export const DEFAULT_DEVICE_EXTRACTION_MODE: DeviceExtractionMode = 'saves';

export function coerceDeviceExtractionMode(value: string | undefined): DeviceExtractionMode {
  return DEVICE_EXTRACTION_MODES.includes(value as DeviceExtractionMode)
    ? (value as DeviceExtractionMode)
    : DEFAULT_DEVICE_EXTRACTION_MODE;
}

// The synced theme preference — the same three fields as `@stxapps/shared`'s
// `ThemeState` (`mode` + the two `custom`-mode crossover times), stored inside
// `settings/general.enc` (the "Sync" tab). The device-local alternative ("Device"
// tab) lives off-sync in the web-react `localSettings` store, never here — exactly
// like `linksLayout` below.
//
// Every field is DELIBERATELY permissive (`z.string()`, not `z.enum(THEME_MODES)`
// or a time regex): this schema parses PERSISTED bytes, and a strict field failing
// would fail the WHOLE `settingsGeneralSchema` parse and drop the entire blob from
// the UI — taking `linksLayout`/`serverExtraction` down with the theme. A newer
// client's unknown `mode`, or a malformed time, must parse harmlessly instead. The
// read edge (`coerceThemeState`) is the one that validates/normalizes these into a
// real `ThemeState`. (`THEME_MODES` in theme.ts is what a writer/UI enumerates the
// modes from; it is not used to gate parsing here.)
//
// Each field also `.catch('')`es, so a NON-string (a future client storing a richer
// `mode`, a corrupt byte) degrades to the empty string — which `coerceThemeState`
// already maps to the default — rather than failing this object. Combined with the
// `.catch(undefined)` on the parent's `theme` field, no theme value of any shape can
// fail the settings parse. A partial theme survives per-field too: `{ mode: 'dark' }`
// with no times keeps the mode and defaults the times, instead of losing all three.
//
// This is `z.object`, not the file's usual `looseObject`: theme is a CLOSED shape
// (only these three fields feed `resolveTheme`), so there are no unknown sub-keys to
// round-trip, and `z.object`'s inferred type stays index-signature-free so a real
// `ThemeState` assigns straight into it (a `looseObject`'s catchall index signature
// would not). Forward-compat still holds at the level that matters: the PARENT
// `settingsGeneralSchema` is `looseObject`, so a future client's new SIBLING setting
// round-trips — the extension path for growth here is a new field beside `theme`.
export const themeStateSchema = z.object({
  mode: z.string().catch(''),
  lightStart: z.string().catch(''),
  darkStart: z.string().catch(''),
});
export type SyncedThemeState = z.infer<typeof themeStateSchema>;

// The plaintext of the well-known path `settings/general.enc`. Concern-scoped
// settings files (the LWW-isolation move — see the doc's "data model"): add a
// field here for a general setting, or a NEW `settings/<concern>.enc` schema
// when a group of settings should stop clobbering the rest under LWW.
//
// NO SETTING FIELD CAN FAIL THIS PARSE. Every value field is optional AND
// `.catch(undefined)`, so a value of the wrong shape reads as ABSENT and the
// caller's default applies — one bad field can never drop the whole blob (and with
// it every OTHER setting) from the UI. This is the theme doctrine (see
// `themeStateSchema`) applied to the file as a whole: it parses PERSISTED bytes
// written by past and future clients, so it must be maximally forgiving.
//
// The two exceptions are DELIBERATE and are the frame, not a setting:
// `createdAt`/`updatedAt` stay strict `z.number().int()`. They're the LWW clock the
// sync merge orders writes by — a blob without them isn't a settings file with a bad
// setting, it's not a settings file. They're also the only thing separating a real
// blob from arbitrary JSON at the IMPORT edge (`classifyBundleLine` in
// import-all-data.ts gates on this schema), which would otherwise accept `{}`.
//
// `linksLayout` is OPTIONAL: it's the SYNCED links layout (the Settings → Misc
// "Sync" tab). Absent until the user picks one, and an older client that never
// wrote it still parses. It's a free `z.string()`, NOT `z.enum(LINKS_LAYOUTS)`:
// the enum is the WRITER's list (see LINKS_LAYOUTS), and validating reads against it
// would mean a layout added later (a newer device syncing `table`) fails this parse
// on every older client and takes the theme down with it. Unknown values instead
// round-trip untouched, and the read edge falls back to its default for rendering
// (bracemark-web's `Main` picks `ListLayout`) while the Settings UI simply shows no
// selection — the user's choice on the newer device is preserved, not clobbered.
// The device-local alternative ("Device" tab) lives off-sync in the bracemark-web
// `localSettings` store, never here.
//
// `serverExtraction` is the SECOND, explicit opt-in (see docs/link-extraction.md
// "server extraction" / "the stance"): the user lets a web/desktop client send a
// saved link's URL to `bracemark-extractor` for title/image extraction. It is a SYNCED
// account preference (every device honors the same choice), and OFF BY DEFAULT —
// absent or `false` means no URL ever leaves the browser. `looseObject` round-trips
// it for clients that don't model it (e.g. the extension, which is active-context
// only and never calls the extractor).
//
// `deviceExtractionMode` is its ON-DEVICE sibling — what a client that fetches the page
// ITSELF may do (bracemark-expo: no CORS, so no server is involved and no new party learns
// the URL). A DIFFERENT thing is being consented to, so they are deliberately two
// fields, not one: `serverExtraction` admits a new party; this one governs NETWORK
// ACTIVITY FROM THIS DEVICE. It is a three-position ladder rather than a boolean
// (DEVICE_EXTRACTION_MODES above has the positions and why `off` earns its place):
// `saves` — the default — draws the line at the doc's gestured/un-gestured split, so a
// link the user just saved here is extracted while the residual is not, and `all` adds
// the residual (synced/imported links, plus the per-host favicon cache that rides
// along). SYNCED rather than device-local because it's an account-level trust decision
// ("my devices may fetch the pages I save") that a second phone should inherit; a
// metered-connection qualifier, if ever wanted, is a device-local companion, not a
// second copy of this. Round-tripped by `looseObject` on clients that don't model it
// (bracemark-web/the extension never read it).
export const settingsGeneralSchema = z.looseObject({
  linksLayout: z.string().optional().catch(undefined),
  serverExtraction: z.boolean().optional().catch(undefined),
  // A free `z.string()`, narrowed by `coerceDeviceExtractionMode` at the read edge —
  // see DEVICE_EXTRACTION_MODES for why the tolerant parse matters here.
  deviceExtractionMode: z.string().optional().catch(undefined),
  // The SYNCED links sort — the two orthogonal axes (see LINK_SORT_ONS /
  // LINK_SORT_ORDERS above): `sortOn` the field (date modified vs. added),
  // `sortOrder` the direction. Global-only (no device split, unlike `linksLayout`):
  // the synced value IS the applied one. OPTIONAL and a free `z.string()` for the
  // same reason as `linksLayout` — a strict enum would fail this whole parse on an
  // older client if a newer one stored an unknown value, taking every other setting
  // down with it. The read edge coerces each with `coerceLinkSort*` and falls back to
  // the default (`updatedAt` / `desc`); an unknown value round-trips untouched.
  sortOn: z.string().optional().catch(undefined),
  sortOrder: z.string().optional().catch(undefined),
  // The SYNCED theme (the Settings → theme "Sync" tab). OPTIONAL like `linksLayout`:
  // absent until the user picks a synced theme, and an older client that never wrote
  // it still parses — `looseObject` round-trips it. Permissive by design (see
  // `themeStateSchema`); the read edge coerces it with `coerceThemeState`. The
  // `.catch` covers theme values that aren't objects at all (`themeStateSchema`'s own
  // catches cover the fields within). The device-local alternative ("Device" tab)
  // lives in the `localSettings` store.
  theme: themeStateSchema.optional().catch(undefined),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type SettingsGeneral = z.infer<typeof settingsGeneralSchema>;

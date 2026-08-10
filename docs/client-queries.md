## reading & paginating the link library

How the link views read from the local store fast, stay live, and paginate at a
few-thousand-link scale. See [architecture.md](./architecture.md) for the package
layering and [local-first-sync.md](./local-first-sync.md) for how those links got
into the local store in the first place (encrypted blob per file → decrypted
local store). This doc describes the read model **canonically**, with bracemark-web /
`packages/web-react/src/data/queries.ts` (Dexie over IndexedDB) as the reference
implementation; bracemark-expo's `packages/expo-react/src/data/queries.ts` is a
drizzle-over-SQLite port holding the same semantics — see
[the expo port](#the-expo-sqlitedrizzle-port) at the end for where it diverges.
The pieces: the typed read layer (`queries.ts`), the indexes in each app's
`data/db.ts` that serve it, the shared `@stxapps/shared` `sync/decode-cache.ts`
memo, and the virtualized layouts (web: `app/(app)/links/_layouts/`; expo:
FlashList under `features/links/`). The URL⇄`LinkQuery` grammar (now shared —
`sync/link-query.ts`) and the write path that produce the queries this edge reads
live in [search.md](./search.md).

The decisive constraint is **scale on one device**: a user can save several
thousand links, all resident in IndexedDB, and the UI reads from that store on
every render — never the network. So the read path has to avoid O(library) work
on each reactive tick, and pagination has to avoid materializing the whole
library into memory.

### IndexedDB indexes do the heavy lifting

A link's authoritative data is an **opaque encrypted blob** (`data` on the
`items` record). You can't index or query ciphertext, so the few fields a list
view sorts and filters on are **projected** out of the blob into plain indexed
columns by the single write-edge projector (`data/projection.ts` `toItemRecord`),
written in the same `put` as the blob so they can never drift from it. Every
projected column (`itemListId`, `*itemTagIds`, the date keys) comes from the
**user-authored `links/` blob**, so the writer-split that moved the extracted
`title`/`imageId` into a separate `extractions/{id}.enc` record (see
[local-first-sync.md](./local-first-sync.md)) leaves **sort and non-text filtering
untouched** — only the displayed title/image and a `title` search term need the
co-keyed extraction record (see below). db.ts declares:

```
path, updatedAt,
[itemType+itemUpdatedAt], [itemType+itemCreatedAt],
[itemListId+itemUpdatedAt], [itemListId+itemCreatedAt],
*itemTagIds
```

- The **compound indexes** turn "newest links in this list/everywhere" into an
  ordered index range walk that materializes only the page shown, instead of
  reading + `JSON.parse`-ing every blob to sort in memory. Each sort dimension
  (`updatedAt` = date modified, `createdAt` = date added) has its own pair.
- The **`*itemTagIds` multiEntry index** answers tag membership without a scan.
- `updatedAt` (the blob's write / R2-LastModified time) is **distinct** from
  `itemUpdatedAt` (the user-meaningful display sort key) — the former versions
  the bytes, the latter orders the view. This distinction matters again for the
  decode cache below.

`queries.ts` `readRest` picks the cheapest driver for the clauses present: a
single positive list (or no filter) walks one compound index with an exact
`.count()` total (`rangeFastPath`); a positive tag clause drives the
`*itemTagIds` index and finishes over that subset (`finishFromCandidates`);
anything else (multi-list, `none`, text words) walks the all-links ordered index
and filters/decodes lazily, stopping at the page. **Text predicates live inside the
blobs, so they can never be index-served** — they're always a JS post-filter, and
the total is non-exact under search. Note the one cross-record wrinkle from the
writer-split: a `url` word matches on the decoded **link**, a `title` word matches on
the decoded **extraction**, and a basic `text` word matches the **combined url⊕title**
haystack (so it reads both). Any clause that touches the resolved title — a `title`
**or** a `text` clause, gated by `needsExtractionJoin` — **joins the co-keyed
`extractions/` record** (same `{id}`) and decodes it too. That join is the deliberate
cost of keeping `links/` user-only; it falls only on text search (and on row display,
for the title/image), never on the index-served browse path. (`text` is the basic
"words, all links" clause; `url`/`title` are the field-scoped advanced clauses — the
grammar that names them is [search.md](./search.md).)

**Why not project a `displayTitle` column onto the link record instead?** It would
make `title` index-/scan-served again, but it would have to be derived from a
**different** record's blob (the extraction's), so it could no longer be written in
the link's own `put` — breaking the "same-`put`, can-never-drift" invariant the
projector depends on, and forcing every extraction write to also touch the link's
projected row (a cross-record write the split exists to avoid). The read-time join
keeps the synced truth cleanly writer-split and the projector single-record; if
title search ever profiles as hot, the right fix is a **local-only** derived column
rebuilt on ingest (never synced, so no LWW), not a projected column on the link.

### liveQuery + virtual scrolling

Two libraries carry the UI (the expo equivalents — `useLiveRead` over
expo-sqlite's change listener, and `FlashList` — are in [the expo port](#the-expo-sqlitedrizzle-port)):

- **Dexie `useLiveQuery`** (`_hooks/use-links.ts`) subscribes the view to the
  query. It re-runs `readLinks(query, limit)` whenever `query`/`limit` change
  **and on every `items` write**, so the list stays consistent with local edits
  and incoming sync with no manual invalidation.
- **`@tanstack/react-virtual`** (the list/card/table layouts) mounts only the
  rows in view, so rendering a large result set stays cheap regardless of how
  many links matched.

These compose: `useLiveQuery` produces the current array, the virtualizer renders
a window of it. Both are reactive, so a write refreshes the data and the visible
rows together.

### pagination: growing `limit` + a decode cache

The current model is deliberately the **simplest thing that works for every
query kind**:

- `useLinks` holds one `limit` (starts at `PAGE_SIZE`); "show more" grows it by
  `PAGE_SIZE` and `useLiveQuery` re-runs `readLinks` for the larger page.
- `readLinks` always returns the **pinned overlay** whole (pins are few, never
  paginated) followed by the page of the rest, with pins excluded from the rest
  so nothing double-shows.

**Why a growing count and not a cursor.** A forward cursor that fetches each page
once and never re-reads it would be cheaper — but it's incompatible with this UI,
not merely unattractive. `useLiveQuery` runs `readLinks` as a **pure function of
the DB**, re-executed in full on every `items` write, because every
already-loaded row must stay live (a local edit or incoming sync can change row 3
while you're scrolled to row 400). A cursor is stateful — it assumes earlier pages
are fixed and won't be re-fetched — so there's nowhere to thread its resume token
through a liveQuery, and the rows behind it would go stale. A growing `limit`
re-runs cleanly as one query and yields a single contiguous `links[0..limit]`
array, exactly what the virtualizer indexes by position. So the forcing chain is:
**live updates on already-loaded rows ⟹ re-execute the whole query each tick ⟹
growing-`limit`, not a cursor ⟹ a decode cache to keep that re-execution
affordable.**

The one optimization on top is the **decode cache**
(`@stxapps/shared` `sync/decode-cache.ts` — shared verbatim by both engines).
Because `useLiveQuery` re-reads the whole loaded prefix on every write, and
decoding a link (`parseBlob` → `JSON.parse` + zod) is the costliest step of a
read, re-decoding that prefix on every tick is O(loaded) zod work per keystroke
or sync. The cache memoizes decoded links keyed by `path` and **versioned by the
pair (`record.updatedAt`, `record.itemUpdatedAt`)**. Neither alone is enough, and
they cover each other's blind spot: `updatedAt` (the R2 stamp) catches any
server-side rewrite but is _frozen_ by the local write edge at its reconcile base,
while `itemUpdatedAt` (the in-blob "date modified") moves on every local edit but
survives a merge/migration that keeps the modified time. That turns re-decode into
O(changed): only records whose bytes actually changed re-parse.

**The pair has exactly one blind spot, and the writer closes it.**
`itemUpdatedAt` is `Date.now()`, so **two local writes to the same path inside one
millisecond are identical on both axes** and the first one's decode would be served
for the second's bytes — until some later write or sync moved a version. That is a
routine sequence, not a corner: the extension's `titleImage` capture writes the
title and then the terminal facet state back to back whenever the page has no
preview image to resize (docs/link-extraction.md), and a settings picker writes per
keystroke. The clock can't be given more resolution — it's a persisted, synced
field, not a cache token — so **each platform's `mutations.ts` calls
`dropCachedPath` after the write's transaction commits** (after, so a reader racing
the window can't re-cache the pre-write decode under the pre-write version). The
version pair is therefore about writes this device _didn't_ make; its own writes
invalidate exactly. The cache is keyed by `path`, so it spans **both**
record kinds the writer-split produces — the `links/` blob and its co-keyed
`extractions/` blob — each versioned by its own `updatedAt`. So the per-row join
(resolving the displayed title as `customTitle ?? extraction.title ?? host(url)`
and the image as `customImageId ?? extraction.imageId`) is also O(changed): an
extraction landing re-decodes only that one extraction record, not the link beside
it, and vice-versa. It's bounded (FIFO-evicted, with the cap set well
above any plausible resident set so eviction effectively never fires), and it's
cleared on sign-out from
inside `clearSyncData` — co-located with the `items` wipe it mirrors, so a second
user on the device can't read the first's decoded plaintext.

**Why this is good enough.** It's a handful of lines, one mental model, and it
works **identically for every query** — single-list browse, tag filters, text
word search, multi-clause combinations — because pagination is just "read the top
N of whatever the driver produced." Nothing about it special-cases the hard
queries. At a few thousand links the residual cost (re-_reading_ — not
re-decoding — the prefix bytes from IndexedDB each tick) is comfortably fast.

### the pinned overlay (pin-to-top)

Pinned links float to the top of **every view they appear in**. They live in
their own small `pins/` namespace (one pin per link, LWW-isolated — see the
[pin-to-top design](./local-first-sync.md) note), not as a flag on the link, so
`readLinks` composes them as an **overlay** on top of whatever the driver
produced rather than threading a pin column through every index path:

```ts
const overlay = await readPinnedOverlay(query); // pinned matches, rank order
const rest = await readRest(query, limit, overlay.paths); // page, pins excluded
return {
  links: [...overlay.links, ...rest.links],
  pinnedCount: overlay.links.length,
  total: rest.total === undefined ? undefined : overlay.links.length + rest.total,
  hasMore: rest.hasMore,
};
```

Four properties hold, and they're worth stating because they're what keep the
overlay from quietly corrupting counts or duplicating rows:

- **No limit, no pagination on pins.** `readPinnedOverlay` returns the _whole_
  set of matching pins every time; `limit`/"show more" grows only the rest. This
  is safe precisely because pins are few by design (a user pins a handful), so
  there's no page to bound — reading them all is cheap and they always render
  even before the first "show more". The overlay still applies the _same_ column
  - text predicates as the active query (`columnMatches` / `textMatches`), so a
    pinned link that doesn't match the current list/tag/search filter is skipped,
    not force-shown.
- **Excluded from the rest.** The overlay hands `readRest` the set of pinned
  `paths`, and every driver drops them (`exclude`), so a pinned link that would
  _also_ fall in the normal page never shows twice — it appears once, at the top.
- **Total stays the same.** Because the pinned links are _moved_, not added,
  `total` must be unchanged by pinning. The rest's total already excludes them,
  so the overlay folds its own count back in: `overlay.links.length +
rest.total`. (When the rest's total is `undefined` — text search can't count
  without decoding the whole match set — the combined total stays `undefined`;
  pinning doesn't rescue an inexact total.)
- **`pinnedCount` is the boundary, not a separate list.** Rather than return two
  arrays, `readLinks` concatenates pinned-then-rest into one `links` array and
  reports how many leading entries are pinned. That single number is what the UI
  draws its pinned section divider and its menu-based "move up · move down"
  reorder affordances at (there's no drag-and-drop — see the design note). One
  array keeps the virtualizer and the decode cache working uniformly across the
  whole result; `pinnedCount` is just where the view splits it.

The overlay reuses the existing read primitives — `decodeCachedLink` for the
same memoized decode, `columnMatches`/`textMatches` for the same filters — so it
adds no new query path and no special-casing in the drivers. It's the same "read
the top of whatever matched" model as the rest, with the pinned matches simply
read in full and stitched on first.

### why the re-read cost rarely materializes

The one cost the decode cache doesn't address is the **re-read**: every `items`
write re-runs `readLinks(query, limit)`, which re-reads the top `limit` records'
blobs from IndexedDB regardless of how few changed (cost is O(loaded), not
O(changed)). At a fully-expanded large list that's tens of ms per tick. In
practice three things keep you off that path:

- **`InitialSyncGate` absorbs the one bulk event.** The first device pull writes
  the whole library, but the gate holds the app subtree back (the
  "Decrypting your links…" screen) until the store is `ready` — so the link
  view's `useLiveQuery` isn't even mounted during those thousands of writes,
  and nothing re-reads on each one. IndexedDB persists, so this full pull happens
  **once per device**; every later session syncs small deltas against the
  resident store.
- **The list starts at `PAGE_SIZE`.** `useLinks` mounts at one page and only
  reaches a large `limit` through deliberate "show more" clicks, so the live view
  usually holds a few hundred rows — re-runs are cheap. The expensive
  large-`limit` state is uncommon by construction.
- **Background syncs are small.** A delta commit writes a handful of records and
  fires few re-runs.

The residual cost therefore only surfaces in a specific corner: the user has
**manually expanded near the full library** _and_ a **burst of writes** arrives
(a chatty background sync, or heavy local editing at that depth) — each re-run
then re-reads the whole expanded prefix. That combination is rare enough that
windowing (below) isn't worth its complexity yet; if profiling on real libraries
shows it biting, that's the trigger to revisit.

### the extraction-queue reads: cursor vs. bulkGet

A separate pair of reads feeds title/image extraction (the queue is a query —
see [link-extraction.md](./link-extraction.md)), and they make the **opposite**
primitive choices from the link-library reads above. That's not inconsistency —
it's the liveQuery rule from §pagination playing out twice, in opposite
directions.

- **`readLinksPendingTitleImagePage`** backs the whole-library "enrich all"
  drain. It is **not** liveQuery-backed — it's an imperative, on-demand paged
  walk — so a forward `cursor` is legal here, the very thing the link views
  can't use. It returns up to `limit` links whose `titleImage` facet is **pending
  and eligible** (facet absent, or a `failed` facet cooled past
  `backoff(attempts)`; `done`/`permanent` are settled and skipped), newest-first,
  plus the cursor to resume. The forward cursor buys O(library) total across the
  drain instead of the O(library²) of re-scanning from the top each batch, with
  memory bounded to one `SCAN_CHUNK`. It also keeps eligibility **fresh**: a link
  a concurrent sync settles mid-drain falls behind the cursor and never costs a
  redundant (paid) extract.
- **`readLinksPendingTitleImageForLinkPaths`** backs the always-on automatic
  probe, scoped to the links currently rendered on screen. This one **is**
  liveQuery-backed (re-runs on every `items` write), so it must be O(displayed),
  never O(library): it `bulkGet`s the known finite set of displayed paths (the
  links plus their co-keyed extractions) and applies the same inline eligibility
  test. Because the key set is finite and already known, `bulkGet` is the right
  primitive — no scan, no cursor.

The pairing is each other's inverse, and the liveQuery rule is what decides it:
the enrich-all read is **unbounded but not reactive**, so it can carry a cursor;
the displayed-scoped read is **reactive but bounded**, so it must stay small and
uses `bulkGet`. Same store, opposite constraints, opposite primitives.

### alternatives deliberately not built (yet)

Three more sophisticated approaches were considered and **rejected for now** —
each buys something real but adds complexity or forks the read path, and none
pays off at the current scale. Documented here so the trade-offs don't have to be
re-derived.

**Key-bound (value-anchored) reads** — page by growing the index key bound
instead of the count. _Pro:_ the loaded window is anchored to a stable key, so an
insert/delete above the scroll position doesn't make the bottom boundary
flicker/drift the way a position-anchored `limit` window can. _Con:_ under
`useLiveQuery` it re-reads and re-decodes the same prefix as growing-`limit` — so
it's **no cheaper**, only marginally more stable, and adds cursor-tracking and
tie-break handling (the compound indexes have no `path` tiebreaker). Not worth the
complexity for a stability nicety.

**Windowed `liveQuery`** — size the virtualizer to the exact total and fetch only
the visible slice (`offset(start).limit(window)`), re-querying as the user
scrolls. _Pro:_ flat memory and flat decode at any depth, plus a true full-range
scrollbar (random access / jump to middle). _Con:_ `.offset(n)` is O(n) in Dexie
(deep jumps walk and discard n entries); the window re-subscribes on nearly every
scroll tick, causing "Loading…" flicker on fast scroll; and it **only works on
the index-served browse path** — tag/text queries must materialize their match
set anyway, and text has no exact total to size the scrollbar with. It would fork
`readLinks` into two paths. Best reserved for tens-of-thousands or a hard
random-access-scrollbar requirement.

**Pagination on the URL path** (numbered `?page=N` pages, e.g. for the table
layout) — chunk-by-chunk `offset+limit` queries with a numbered pager. _Pro:_
structurally bounded memory/decode (one chunk, never accumulating) and shareable
page URLs. _Con:_ a numbered pager needs an **exact total**, which only the
index-served fast path provides — under text search the total is `undefined`, so
the pager degrades to next/prev; pins would need page-1-only handling; offset
drifts under concurrent writes; and it forks the read path + UI for the table
while the other layouts stay infinite-scroll. Only worth it behind a specific
product need (shareable page URLs, jump-to-page, or a flat-memory requirement).

The common thread: the current approach is the only one that's both **simple**
and **uniform across all query kinds**. The alternatives optimize the browse
fast path at the cost of complexity, scroll-time UX, or a second code path for
search/tag/pinned queries — so they wait until profiling or a product requirement
forces the issue.

### the expo (SQLite/drizzle) port

bracemark-expo runs the **same read model over a different substrate**:
`@stxapps/expo-react`'s `data/queries.ts` is drizzle-over-`expo-sqlite` where
web-react is Dexie-over-IndexedDB. Everything above — the projected columns, the
per-query-kind driver choice, the pinned overlay, the growing-`limit` pagination,
the shared decode cache, the totals-go-`undefined`-under-text-search policy —
holds identically; the port's own file header is the line-by-line map. What
changes is mechanical, and only the substrate forces it:

- **Indexes → drizzle SQL.** The compound-index fast paths become
  `WHERE … ORDER BY <sort column>, path` — the explicit `path` tiebreak
  reproduces the primary-key order Dexie gives equal-timestamp rows for free —
  and the sparse "rows without the sort column never appear" property becomes an
  explicit `IS NOT NULL` on that column.
- **multiEntry tag index → junction table.** Tag membership is the
  `item_tag_ids` junction (db.ts): the tag driver selects candidate paths from
  it, and the tag predicates read a junction-built `path → tagIds` map instead of
  a `record.itemTagIds` array. Like web, the tag path materializes its subset and
  finishes in JS rather than pushing an indexed join into SQL — the multi-tag
  `all`/`none` predicates need each row's full tag set anyway, and keeping it in
  JS holds the two engines' logic aligned. Fine at few-thousand-links scale.
- **Lazy Dexie cursor → keyset chunk loop.** Dexie's lazy filtered
  `.filter().limit(n+1)` cursor walk becomes a keyset-paginated chunk loop
  (`SCAN_CHUNK` rows per step, resuming strictly after `(sortValue, path)`), so a
  page read still touches a **bounded slice** instead of materializing the
  library.
- **liveQuery → `useLiveRead`, and no zone-echo.** Reactivity comes from
  expo-sqlite's `addDatabaseChangeListener` via the `useLiveRead` hook (which
  re-runs the whole read on any change to the tables it names, coarse-grained by
  table), not from Dexie tracking which index ranges a querier touched. So the
  **zone-echo constraint** the web `readLinks` carries — helper awaits reachable
  from a querier must be `Promise.resolve`-wrapped or writes silently stop
  re-firing the query — **does not exist here**; expo helpers await freely.
  `react-virtual` likewise becomes `FlashList`.

**Ported so far:** the namespace reads (lists/tags/pins/settings), the
link-library query (`readLinks` and its whole driver tree), the by-id / by-url
lookups, and the quota count. **Not yet ported:** the extraction tallies and the
extract-all / displayed-scoped drain-page reads (§the extraction-queue reads) —
they arrive verbatim with the bracemark-expo features that need them, and will keep
the same cursor-vs-`bulkGet` split described there (unbounded-but-not-reactive
carries a cursor; reactive-but-bounded uses `bulkGet`).

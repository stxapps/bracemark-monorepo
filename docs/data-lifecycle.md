## data lifecycle — import, export, delete all data & delete account

The four whole-library actions of the Settings → Data / Account sections and
why each is shaped the way it is. They operate at a different altitude than the
sync plane ([local-first-sync.md](./local-first-sync.md) — individual paths)
and the account plane ([account.md](./account.md) — keys and credentials).

**Where each runs is forced by E2E encryption, not preference.** Import and
export are **client-only** — the server holds your library only as ciphertext, so it _can't_
serialize a bookmarks file or parse one; the plaintext work has to happen where
the key is, and no plaintext ever leaves the device (export writes a local
file, import reads one — the only server traffic is the ordinary sync plane).
Deletion is the one lifecycle action the server _can_ do better than a client
(the envelope — the key prefix — names what to delete, no content knowledge
needed), which is why delete-all is a server endpoint while its predecessors in
the Gaia era were client loops.

The two destructive actions in one view: **delete all data** wipes the bytes
and keeps the identity; **delete account** takes both.

|                      | Delete all data (Settings → Data)               | Delete account (Settings → Account)                     |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| R2 + op log + quota  | wiped                                           | wiped (same service)                                    |
| local store          | synced stores wiped; session/device stores kept | everything wiped (full `clearData` via sign-out)        |
| account rows / doors | untouched                                       | deleted — doors gone = the cryptographic kill           |
| sessions             | kept (you stay signed in)                       | all revoked                                             |
| subscription         | untouched                                       | must not be live (409 gate); canceled-entitled forfeits |
| username             | untouched                                       | tombstoned — occupied forever (loosenable later)        |
| guard                | confirm checkbox                                | fresh password-signed proof + bearer token + checkbox   |
| undo                 | none                                            | none                                                    |

### export — read the local store, apply policy once, serialize per format

`web-react` `data/export-all-data.ts` (behind `useExportAllData`) orchestrates;
the three interop serializers are pure functions in `@stxapps/shared`
(`export/`). What both platforms' orchestrators must agree on — the
`ExportFormat` union, the progress phases, the outcome counters, the MIME types
and the file name — is `data/export-run.ts`, the sibling of `data/import-run.ts`;
expo's outcome extends the shared one with the cache file its share sheet
presents. Four formats, one deliberate asymmetry:

- **bracemark** — the complete backup: a zip of `manifest.json` + `items.jsonl`
  (raw `{path, data}` entities) + `files/{id}` (raw decrypted blob bytes). The
  **only format that round-trips**, and the only one that includes Trash — a
  backup that silently drops data isn't one.
- **netscape** (browsers, Karakeep), **csv** (Raindrop.io),
  **text** (URL per line) — the interop formats. Trash is excluded here:
  importing deleted-pending links into a browser as live bookmarks is never
  wanted.

The marketing site's separate `/tools/bookmark-converter` reads portable
bookmark files in a browser worker: Netscape HTML, URL-column CSV, strict
URL-per-line text, LinkWarden JSON, Brace.to exports, ZIPs containing those
formats (including Pocket CSV parts), and Bracemark backups. It writes HTML,
spreadsheet-protected CSV, or URL text using the shared serializers. Optional
parser observers account for source records, skipped records, empty folders and
structural damage without changing app import behavior: having an observer
never changes which links a parse returns or whether it throws, and it is the
converter's observer that turns damage (a truncated HTML entry) into an error.
Brace revision skips are distinct from
repeated URLs, which are kept.

**A Bracemark backup converts the way the app exports.** Its `items.jsonl` goes
through `bundleFromLibrary` (`export/bundle.ts`) — the same function both
platforms' export orchestrators call — after `mergeSystemLists`, so a converted
backup and an in-app export of the same library are the same file: the same
folders (system lists included, overridden or not), override-wins titles,
newest-first order. Locked lists never reach it; the backup already leaves them
out. Only link lines and invalid lines count as records; lists, tags, pins,
extractions and settings support them. A backup from a newer app is refused in
the site's own words (`BackupVersionError`), since there is no app to update.
Writing a backup is deliberately not offered: a converted file has no ids to
dedupe by, so a restore's skip-existing-by-path merge would duplicate every link
already saved, where importing the original file dedupes by URL.

**Trash is left out of every source, as the app's export leaves it out** —
importing links pending deletion into another app as live bookmarks is never
wanted, whether the Trash came from a backup or a Brace.to export. The receipt
counts them (`trashCount`) apart from skipped records, which are records that
could not be read. Archive stays, as an ordinary folder with a warning.

Generated files are parsed again: their ordered URLs must agree, and changes to
titles, paths, notes, tags, and dates appear in the receipt before download.
HTML preserves identified empty folders; CSV/text report their removal. CSV
formula-like cells gain an apostrophe, also disclosed. The tool does not read or
write an account; original files still import directly through Settings → Data.

Limits cover file and expanded ZIP bytes, archive entries, bookmark records,
folder count and depth, plus a worker deadline — see _the bookmark converter's
limits_ below. The depth limit is the app's own import rule
(`IMPORT_MAX_FOLDER_DEPTH`), read from one constant. ZIP decoding uses native streams in the existing worker, checks
CRCs, and measures emitted bytes as well as declared sizes. It never fetches
saved addresses or archive references. Clear/cancel and unmount terminate work;
changing the output replaces the receipt and download.

Export reads the **local** store (unsynced edits on this device are included)
after a pre-export sync refresh; a failed refresh downgrades to a warning —
"this is this device's copy" — rather than aborting. A server that never answers
counts as failed: the contract client's default deadline fails the refresh after
60 s ([local-first-sync.md](./local-first-sync.md), under the single-flight bullet), so
the export can't hang on its sync step. The policy that spans all
formats is decided once in the orchestrator: **locked lists are excluded**
(the lock provider's coverage set, descendants included; excluded links drop
with their pins/extractions/files, and the list entities drop too — a hidden
list's _name_ is as sensitive as its contents; the UI warns with the count),
and a dangling `listId` files under My List, the read layer's reconciliation
spirit. The backup reads raw plaintext, so it drops a covered list by the id of
its **path** — the id the coverage set was computed over (_import_, below: a
list's identity is its path) — and never by the `id` copy inside, which is the
one the read edge does not trust; the interop formats take lists and tags from
`readLists`/`readTags`, which have already made that substitution.

### the export's empty run

An export that matches **nothing** — an empty library, every link in Trash under
an interop format, every list locked — still writes its file and still reports a
receipt. There is no pre-flight "you have nothing to export" gate, and the
ordering is why: on web the save destination has to be claimed by
`showSaveFilePicker` **before** the sync refresh and the gather (it needs the
click's transient user activation), and the count only exists after them. A gate
would have to run off a separate live count in the view, which buys one avoided
save dialog in the state a brand-new account is in, at the cost of the only
settings action that pre-emptively disables itself.

So the emptiness is the **receipt's** job, and the receipt names the file first —
"The file was saved, but there were no links to put in it." (expo: "created", where
the file lands in cache and the share sheet is presented over it). The two
tempting shorter lines are both wrong: `Exported 0 links.` claims a success for a
file with nothing in it, and delete-all's bare shape — "There was no data to
delete." — would contradict the download the user is looking at. Delete can say
that because it genuinely produces nothing; export always produces a file. The
existing warnings supply the _reason_ where there is one, so a locked-out run
reads "…no links to put in it. 2 locked lists were not included."

The subtler zeros are deliberately not distinguished from each other. Telling
"library is empty" apart from "the policy filtered everything" before the run
would need a per-format pre-flight count; after the run the warnings already
carry it.

### the bookmark converter's limits

The converter is client-only, so no limit protects a server. They protect the
tab: a browser that runs out of memory kills the page with no message, while a
limit is a sentence the user can act on. On a phone the budget is the tab, not
the device's RAM — an iOS tab is killed well before the phone runs short.

**One set of limits for every input: 60 MB expanded and 100,000 records**, plus
100 entries in a ZIP of portable files. A Bracemark backup differs in one
respect: the worker reads only `manifest.json` and `items.jsonl` at the
archive's root, as the restore does, and never opens `files/`, so the archive
itself has **no size limit** and its entry count is bounded by the largest
plan's `maxFiles`. Its `items.jsonl` is held to the same 60 MB and 100,000. Past
either limit a backup is sent to the app's own export rather than told to split
the file, which a backup can't be.

The two limits are set so that the record count is what an ordinary library
meets: 100,000 bookmarks without long notes are 15–17 MB of HTML or CSV and
~53 MB of `items.jsonl`, all under 60 MB. Long notes are what make the byte
limit arrive first, which is why the help text says "fewer if they carry long
notes" — a limit stated in copy is a claim ([brand-assets.md](./brand-assets.md),
_only what ships_). A 50 MB backup limit was tried first and broke that sentence:
it stopped a note-free library at ~94,000 links under a help text that said
100,000.

**2026-09-27, measured** in Node on a laptop — the memory each conversion adds
above its input, at the limits. Portable rows are generated bookmarks files;
backup rows are `e2e/seed`'s `plus-full` library.

| input                  | records | notes     | size  | → HTML  | → CSV   |
| ---------------------- | ------- | --------- | ----- | ------- | ------- |
| bookmarks HTML         | 100,000 | none      | 17 MB | ~330 MB | ~350 MB |
| CSV                    | 100,000 | none      | 15 MB | —       | ~350 MB |
| bookmarks HTML         | 89,000  | 500 chars | 60 MB | ~500 MB | ~590 MB |
| CSV                    | 91,000  | 500 chars | 59 MB | ~520 MB | ~620 MB |
| backup (`items.jsonl`) | 100,000 | none      | 53 MB | ~230 MB | ~230 MB |
| backup (`items.jsonl`) | 57,000  | 500 chars | 59 MB | ~340 MB | ~310 MB |

All of it finished in under 2 seconds, inside the worker's 60-second deadline
with room for a slower phone.

**What made that possible was the CSV scanner, not the limit.** The limits were
16 MB and 25,000 records for portable files until the same day, and even those
were too high: `scanCsv` (`import/csv.ts`) built each field a character at a
time, which V8 keeps as a chain of one-character strings until something
flattens it, so a 16 MB CSV of 500-character notes held **~1.07 GB** — and the
converter runs the scanner twice, on a CSV input and again on its own CSV output
for the verification pass. Building fields from slices took that case to
~213 MB and the 100,000-record CSV-with-notes case from ~2.7 GB to ~580 MB,
with no change to what it parses (the old scanner passes `csv.spec.ts`'s
boundary cases too). The
app's own CSV import runs the same scanner on both platforms and got the same
fix. If the limits ever need to rise again, look for the next thing holding the
input several times over before moving the numbers.

### the bracemark zip is platform-split — and mobile has ceilings web doesn't

Both platforms read and write the same **layout** (`manifest.json` +
`items.jsonl` + `files/{id}`), so a backup made on either imports on the other.
That layout is **one definition, not a convention both sides honor**:
`@stxapps/shared` `data/backup.ts` owns the format id and version, the entry
names, the manifest build/parse, the `items.jsonl` line shape and its
per-namespace schema gate, and the referenced-blob walk. It lives in `data/`
rather than `export/` or `import/` because those two namespaces are the
**interop** ones (netscape/csv/text) — a round-trip contract belongs to neither
direction — and because the cross-platform round trip is the whole point:
a `BRACEMARK_BACKUP_VERSION` bump landing on web alone would produce archives
expo's importer accepts and misreads. Bump it once, both platforms move.

The zip **container library** differs, and not by preference:

- **web** — `@zip.js/zip.js`. Streams straight to disk through the File System
  Access API (`showSaveFilePicker`, claimed before the long phases while the
  click's user activation is alive), so an archive larger than memory never
  materializes as one Blob, and zip64 engages automatically. The restore reads
  the picked File the same way, a slice at a time, and its format sniff reads
  only the four magic bytes, never the whole file. Every import is of the
  **native build**, `@zip.js/zip.js/index-native.js`, never the bare
  specifier — see _which zip.js build_ below.
- **expo** — `fflate`: its synchronous streaming `Zip` to write, fed a piece
  at a time with a yield between pieces (see _readings — expo_), and
  `unzipSync` to read. zip.js is not portable to
  Hermes: its codec pipeline is built on `CompressionStream`/
  `DecompressionStream`, `TransformStream`/`ReadableStream`/`WritableStream`,
  and Web Workers — **none of which exist on React Native**. This isn't a
  polyfill away; it's the whole architecture of the library.

**Which zip.js build.** Both of zip.js's builds deflate and inflate through the
browser's own `CompressionStream`/`DecompressionStream`. They differ only in
the **fallback codec**, used for deflate64 entries, for any `level` other than
the default 6, and in a browser without the native streams: the default build
(`@zip.js/zip.js`) falls back to a WASM zlib, while the native build
(`index-native.js`) falls back to a pure-JS one. Web uses the native build,
both here and in the marketing site's bookmark converter, because the WASM
fallback costs more than it gives:

- The backup's `files/` entries are stored (`level: 0`), and any level other
  than 6 turns zip.js's native-stream path off for the entry. That makes the
  default build load and compile its WASM module in every export, although
  stored entries never run a codec. `manifest.json` and `items.jsonl` use the
  default level, so they go through the browser's streams in either build.
- The default build embeds that module as a `data:` URI and `fetch()`es it
  first. The app's `connect-src` ([hosting.md](./hosting.md)) does not allow
  `data:`, so each export would report a CSP violation before the loader's
  `atob` fallback succeeded. That fallback works only because
  `'wasm-unsafe-eval'` is in the policy for Argon2. On the marketing site,
  which has no `'wasm-unsafe-eval'`, the codec would fail outright, so a
  deflate64 ZIP could not be read.

The native build needs nothing from either policy beyond the `worker-src blob:`
its codec workers share with Argon2's. Lint holds the line, since nothing
else would: both builds share one `index.d.ts` and every spec passes on
either. The root `eslint.config.mjs` restricts the bare specifier twice,
statically in `RESTRICTED_IMPORT_PATHS` and dynamically in `ZIP_JS_SYNTAX`
(`no-restricted-imports` never sees an `import()`), specs included; a type-only
import may stay. Revisit the choice only if the backup
starts deflating at a non-default level: then the fallback codec does real
work, and WASM outruns pure JS. Doing it cleanly means serving
`dist/zip-module.wasm` same-origin via `configure({ wasmURI })` and writing
stored entries as `{ compressionMethod: 0 }` rather than `{ level: 0 }`, so they
keep the native path.

fflate is the right pure-JS choice (jszip is strictly worse on size, speed, and
peak memory, and no pure-JS zipper writes zip64). But it emits a **classic
zip32 end-of-central-directory and no zip64**, which puts two hard ceilings on
the mobile backup that web doesn't have — and fflate range-checks **neither**:

> Feeding `zipSync` 70 000 entries writes `70000 & 0xffff` = **4 464** into the
> 16-bit count field and returns an archive that reads back _clean_, with
> 65 536 files silently missing. In the one format that's supposed to
> round-trip.

Both ceilings sit **inside what the paid plans sell** (`maxFiles` 1 000 000,
`maxBytes` 5 GiB on Plus / 20 GiB on Pro — `@stxapps/shared` `iap/plans.ts`),
so this is reachable rather than theoretical. `expo-react`
`data/export-all-data.ts` therefore asserts them (`assertZipWritable`, before
anything is deflated) and fails with a user-facing `ExportTooLargeError`
pointing at the web app. **Refusing to write a backup is always better than
writing one that quietly drops half the library.** The guard is exported for its
spec and driven there directly, on both sides of each boundary: crossing either
ceiling for real needs 65 536 materialized blobs or 4 GiB of them, so nothing
that goes through the orchestrator can reach it.

**fflate is loaded with `require()`, never `await import()`**, in both expo
orchestrators. Metro resolves the two identically, so the app is the same either
way — but jest's CJS vm cannot service a real `import()` and neither
babel-preset-expo nor `@react-native/babel-preset` lowers one to a require, so an
`import()` here makes the whole orchestrator unreachable from a spec. That is
what it was, and why the round trip went uncovered on this platform for as long
as it did. Same rule and same spelling as the lazy requires in
`expo-react` `data/share-store.ts`; the reasoning is in `jest.expo-base.cjs`.

|              | web (zip.js) | expo (fflate)            |
| ------------ | ------------ | ------------------------ |
| peak memory  | ~one blob    | whole archive, ×2        |
| zip64        | automatic    | **no** — zip32 only      |
| max archive  | 20 GiB+      | **4 GiB** (guarded)      |
| max entries  | unbounded    | **65 535** (guarded)     |
| write target | disk stream  | cache file → share sheet |

The **read** direction is healthier than it looks: fflate _does_ parse zip64
(the extra-field sizes and the zip64 EOCD locator), so a web-made oversized
backup isn't rejected on format. The wall there is memory — the whole archive
becomes one `Uint8Array`, then `unzipSync` expands it — and that fails loudly,
so it needs no guard of its own.

**That each platform reads the OTHER's archive is checked, and it can only be
checked with an artifact.** Each platform's own round-trip spec
(`data/export-import.spec.ts`, both packages) proves it reads what _it_ wrote;
nothing proves the cross direction, and no single spec can — `web-react` and
`expo-react` may not import each other. So two golden backups are checked in,
one per container, at `packages/shared/src/data/__fixtures__` with a JSON sidecar
naming the entity set they hold, and **both** platforms' specs import **both**
zips. They are generated by `tools/scripts/generate-backup-fixtures.ts`, read through
`@stxapps/shared/testing` (the spec-only subpath — the platform specs may not
reach across the tree by relative path), and kept from going stale by
`packages/shared/src/data/backup-fixtures.spec.ts`, which
fails the moment `BRACEMARK_BACKUP_VERSION` moves without them — the same shape,
and for the same reason, as `crypto/contract-vectors.json` for the blob frame
([testing.md](./testing.md), _the ported pair_).

**Upgrade path — a native zipper, not fflate streaming.** fflate's push-based
`Zip`/`Unzip` API paired with `expo-file-system`'s `FileHandle.writeBytes()`
would fix peak memory and _nothing else_: the zip32 ceilings are a property of
what fflate emits, not of how it's fed. The move that actually reaches parity is
native — `react-native-zip-archive` (a TurboModule wrapper over minizip on iOS
and zip4j on Android; `zip(paths, target)` / `unzip` / progress `subscribe`), or
a `BracemarkZip` module in the `BracemarkCrypto` pod. That also fits this platform
better than web's: bracemark-expo already stores blob content **decrypted on disk**,
and `BracemarkFileCrypto` already exists precisely so file bytes never enter the JS
heap — a native zipper is that same path-to-path move one layer up, where
pushing every byte back through Hermes would undo it. Three things to settle
before committing:

- Entry names come from **basenames**, so the export needs a staging directory
  mirroring the zip layout (disk ×2 — cheap next to RAM ×2).
- Import extracts to a directory, but landing the bytes still pulls them through
  JS unless `bulkWriteEntities` grows a **path-based** content variant.
- zip64 follows from the underlying native libraries but isn't documented by the
  wrapper — **verify empirically** before relying on it.

Worth weighing against a product answer: a 20 GiB Pro backup lands in the cache
dir (subject to iOS eviction) and is then _copied_ by the share sheet, so the
top end may simply be **desktop-first backup, interop formats on mobile** —
a decision to make before either port.

### import — detect the format, land through the write edge

`web-react` `data/import-all-data.ts` (behind `useImportAllData`), the write-side
mirror: one entry point takes the picked file, detects the format, and writes
through the normal write edge (`bulkWriteEntities`) — so the pending-ops queue
carries an import to the server **exactly like any other local edit**, and a crash
mid-import loses nothing already written. Detection is two-layered
(`@stxapps/shared` `import/detect.ts`): zip magic first (a bracemark backup is
bytes; a zip _without_ `manifest.json` has its `.html`/`.csv`/`.txt` entries
parsed and concatenated — Pocket's shutdown export is a zip of `part_*.csv`),
then a content-first text sniff (filenames only break ties — files get renamed
to `.txt` in transit, and a misroute degrades gracefully to the URL-extracting
text parser).

**LinkWarden is the second whole-backup format**, and it is one because it has
to be: LinkWarden's only export is `backup.json` (linkwarden#587 and #951 are the
standing asks for an HTML one), so before `import/linkwarden.ts` existed the file
sniffed as text and the URL miner ate the raw JSON — a flat pile of links with
every collection, tag, note, date and pin gone, and no error. Karakeep, which
_does_ write Netscape HTML, always crossed fine.

What crosses now: `collections` nest through `parentId` into a folder chain, a
link's `name` is its title (as `customTitle`, like every interop title — below),
`description` is its note, `tags[].name`
are tags, **`importDate` is the created date** with `createdAt` as the fallback,
`updatedAt` is the updated one, and the user's separate
`pinnedLinks` relation marks pins by id — read as a SET, never as extra rows, or
every pinned link would import twice. What does not: `rssSubscriptions` (feeds),
per-link decor, a collection's `description` (our `List` has only a name), the
user scalars including `collectionOrder`, and LinkWarden's archived copies.

Three of those came from a real `backup.json` rather than from reading
LinkWarden's exporter, and two of them corrected this page
([testing.md](./testing.md), _import specimens_):

- **`importDate`, not `createdAt`.** `createdAt` is when LinkWarden minted the
  row; a library that reached it by import — the ordinary way anyone arrives —
  has every row stamped with the minute of the import run. In the specimen that
  is two values across 25 links. `importDate` holds when each link was really
  saved, so it wins when present. Nothing about the wrong reading looks wrong:
  every link is there, newest-first, all dated the day the user switched apps.
- **A title arrives HTML-escaped.** LinkWarden stores its `<title>` scrape
  without decoding it, so a JSON string carries `&amp;` — the specimen proves it
  in one row, whose `metaDescription` (same page, same scrape) has a bare `&`.
  Titles are decoded at the parse boundary; `description` and tag names are the
  user's own words and are not.
- **The archived copies are IN the export** — this page said they weren't. A
  `pinnedLinks` row carries `preview`/`image`/`pdf`/`monolith`/`readable`/
  `textContent`; a collection's link rows carry none of them, so the two row
  shapes differ. What they hold is a server-side path, never bytes: the specimen
  was re-exported after uploading a custom image and the image is nowhere in the
  file. So no image can cross, and re-fetching one is the single thing import
  must never do — it would announce the user's whole library to every host in it.

Its default collection **crosses as an ordinary folder** — it carries no flag in
the file, so it can't be recognized structurally, and matching it by NAME is the
mistake `systemList` exists to prevent (it would swallow a real folder called
Unorganized and miss a renamed default). One rung downstream a collection named
`archive` DOES land in the system Archive list, because `ListResolver` matches
folders by case-insensitive name and excludes only Trash — the intended reading
of a folder called Archive, and the specimen is the first file to exercise it.
Detection is structural in two parts, an anchor plus a scan, for a reason the file
explains: LinkWarden exports the user's whole Prisma row, so `collections` is not
the first key.

Both halves land through **one projection** — `import/project.ts`
`projectImportedLinks` — which turns parsed rows into the entities to write:
list/tag resolution, which title is held above extraction, custom-image blobs,
pin ranks. It's pure and shared, taking `newId` as an argument like the
resolvers, because every one of those is a **user-visible behaviour that must be
identical on web and mobile**; only the store reads, the chunked writes, and the
progress ticks stay in the two orchestrators.

The policy, decided once:

- **Interop imports dedup by canonical URL identity** (`canonicalUrlKey`, the
  same key behind the quick-add duplicate warning) — against the library _and_
  within the file; skips are reported, never errors.
- **The bracemark backup merges skip-existing by path** — a path already in the
  local store is never touched, so a restore can't clobber newer local edits.
  The initial scan supports the quota gate; each metadata write rechecks
  existence inside its transaction through `bulkWriteEntities`'s
  `skipExisting` option. Sync can land a path between scan and write while the
  importer yields. The receipt counts only paths actually written.
- **A backup line's ids are gated to the path grammar — the path's own, and the
  file refs inside its data.** `classifyBundleLine` refuses a line whose path id
  is not a plain token, and equally one whose `customImageId`, `imageId`,
  `pageCopyId` or `screenshotId` is not. Those four are ids the _archive_
  supplies: a restore turns each into a `files/{id}.enc` path and a queued put,
  and a later delete of the link turns it into a queued delete. One the wire
  contract can't carry is refused by the request contract before it leaves the
  device, on every cycle, and the push it rides in holds the metadata puts and
  the pull behind it — a library that looks restored and has stopped syncing,
  with nothing in the app that removes a single queued op. The line is counted
  invalid, never repaired: stripping the ref would make the restore something
  other than verbatim, and a refused link takes its pin and extraction with it
  (the dangling-satellite drop). Both checks read one definition — `isPathId` in
  `sync/paths.ts`, whose pattern is also the id segment `syncPathSchema` is built
  from — so the reader and the wire cannot disagree. The entity schemas are
  deliberately _not_ where this lives: they also decode what is already stored,
  and a tighter rule there would turn an existing record unreadable. No backup
  this app writes is affected, since every id either platform mints is a UUID;
  the converter counts such a line as an invalid record through the same
  function.
- **A backup line's timestamps are gated to the calendar, at the same edge.** An
  entity's `createdAt`/`updatedAt` are `z.number().int()`, and an integer is a
  larger set than a date: `Date` represents ±8.64e15 ms around the epoch, the
  schema admits every safe integer, and `toISOString` **throws** on a value in
  the gap. The web list row called it in render for the field the list is sorted
  by — hidden column or not — so one such link took down the list layout of
  every view containing it, on every device it synced to.
  `classifyBundleLine` now refuses any line carrying one — a link, list, tag,
  pin, extraction or the settings file, and for an extraction each facet's
  `extractedAt` as well — and counts it invalid, through `isCalendarTime`
  (`sync/calendar-time.ts`). **Refused, never re-dated**
  — a restore promises the admitted values verbatim, and a link that came back
  dated today would not be a restore. As with the ids above, the entity schemas
  are _not_ where this lives, for the same reason: they decode what is already
  stored. So the readers that turn a date into a calendar string tolerate one
  regardless — the list row renders "date unknown" with no `dateTime`
  (`sorted-date.tsx`), and the CSV export leaves the `created` cell empty rather
  than aborting the file. A backup this app wrote carries such a value only when
  the library it was exported from already held one, since the export is
  verbatim as well: that link is then refused on restore and counted, where it
  used to come back and break the list.
- **A backup's list or tag line carries its path's id, or is refused.** Both
  entities hold an `id` in their plaintext that repeats the `{id}` of their path,
  and until this rule nothing compared the two: `listSchema`/`tagSchema` ask for
  a string. So a file could store a list under `lists/a.enc` that called itself
  `b` — a second record on an id another line already held, or a user list
  calling itself `trash` — and every reader went by the copy.
  `classifyBundleLine` refuses the line and counts it invalid, at the same edge
  and for the same reason as the two gates above: this is where the value comes
  from a file rather than from this app. Refused, never rewritten — a restore is
  verbatim. Every writer of a list or a tag in this app builds the path **from**
  the id (`pathFromId`), the first edit of a system list included, so a backup
  carries such a line only when the library it was exported from already held
  the record — pulled from another client, or restored before this rule — since
  the export is verbatim as well. That line is then refused on restore and
  counted: the list or tag does not come back, its children return as roots and
  the links naming it return with a dangling reference. The same trade as the
  calendar rule above. It is one of three rules that hold the same line — the
  read edge and the tree builder are the other two (_a list's identity is its
  path_, below) — and the only one that keeps such a record out of the store.
- **An interop date the calendar cannot name is dropped; the row is kept.** The
  same value reaches the projection legitimately — the epoch parser's unit
  inference is by magnitude, and a source can simply carry a wrong number. A date
  is the one field a row can lose and still be the same bookmark, so
  `projectImportedLinks` treats it as absent, each of the two dates on its own,
  and the row is stamped as an undated one would be. This is what the bookmark
  converter already did with the same value. A date that is not an integer at
  all is still refused by the schema, row and all, as before.
- **A custom image crosses only with a link that was accepted.** The projection
  hands back `files` and the orchestrators write them _first_ (content before
  metadata), so a blob chosen for a row the schema then refuses would be stored,
  queued and uploaded with no link anywhere naming it — counted against the
  account's storage, reported by nothing. The blob is therefore selected
  **after** its row validates, under a provisional id until then. Selection, not
  cleanup: deleting on refusal would take the image from an accepted row that
  shares it. A reference is claimed by the first _accepted_ row, so a refused row
  ahead of it in the file does not cost the later one its image.
- **A folder chain past 100 levels refuses the whole file.**
  `IMPORT_MAX_FOLDER_DEPTH` (`import/resolve.ts`). Every segment of a folder path
  becomes a list, and each format lets the file choose the depth — nested `<DL>`s,
  separators in one CSV cell, a `parentId` chain — so without a bound the file
  decides how deep this library's tree is. `assertImportFolderDepth` asks it of
  every parsed row, before the dedupe and before the over-cap prompt, so the
  verdict is a fact about the file's rows and not about which of them the
  library already holds — and nobody answers "import what fits?" for a file that
  is then refused. The projection asks again before a resolver exists, so nothing of a
  refused file is minted. It throws `ImportFolderDepthError`, whose message both
  import views render verbatim. The
  **file** is refused rather than the deep rows — dropping them would leave an
  import that looks complete, and shortening their paths would file links where
  the file never put them. A system-list row is not counted: its path is never
  resolved. 100 was already the bookmark converter's rule, which now reads the
  same constant and throws the same error; the converter also counts a folder
  with no links in it, which the app never sees as a row. It bounds what an
  import **mints**, not what is stored: a backup restores `parentId` verbatim and
  another device can sync any chain, which is why nothing that reads the tree
  recurses (below). The rule reads the ROWS a parse returns, so a parser has to
  get that far cheaply whatever the file nests: `import/linkwarden.ts` used to
  climb the whole `parentId` chain again from every collection, and 10,000
  nested empty collections — half a megabyte — took 25 seconds to parse before
  there was a row to refuse. It settles each collection's path once now, from
  its parent's, and stops extending one that is already past the limit.

  **A `parentId` loop is cut once, and the file's order picks where.** A loop —
  a hand-edited file, or a restore that reparented two collections into each
  other — has no depth to measure, so the walk cuts it before the rule reads
  anything. Settling each collection once takes exactly one edge out of a loop:
  the collection whose parent is where the first climb entered the loop is filed
  at the top level and the rest nest under it in order, so every collection
  still has one path and a loop mints one list per collection. Which climb is
  first is the order the file lists its collections in, so the same loop listed
  in another order is cut at another edge. The rule then reads the paths as cut
  — the app's rows and the converter's folders both come from this one parser —
  so such a file is refused when one of them is past the limit, and not for
  looping. The walk this replaced gave every member the whole loop, rotated to
  end in itself — the same answer in any order, and a separate copy of the loop
  minted for each member that held a link. `import/linkwarden.spec.ts` holds the
  cut and its dependence on order.

- **The plan's link cap is enforced up front**, _before anything is written_ —
  see _the import's quota gate_ below for the shape, which differs between an
  interop file and a backup. This is one of the places that enforce the cap at
  all — it is client-side (see [iap.md](./iap.md), _enforcement_), so
  `files/sign` would accept an over-cap import without complaint.
- **A file-carried title is the link's own title** — `customTitle`, which
  extraction fills in under but never replaces. No interop format says whether
  the user renamed a link in its source, every one of those sources lets them,
  and a rename overwritten by a later fetch can't be recovered, whereas a page
  title held there is one cleared field from the extracted one. A real Raindrop
  export is where that was learned (below). It used to be the other way round — a
  provisional `extraction.title` — which quietly handed every renamed bookmark
  to the extractor to undo. Two edges: a title that only restates the address
  (what Delicious writes for a bare domain) is dropped, not frozen; and a
  Brace.to export, which keeps the user's title and its extractor's apart,
  still sends the second to `extraction.title` (below). Rationale in full:
  [link-extraction.md](./link-extraction.md), _manual overrides_.
- **A note crosses whenever the format carries one.** The CSV `note` column, and
  Netscape's `<DD>` — the format's description element, and the only construct in
  it with no closing tag, so it runs to the next block tag. Our own HTML export
  writes no `<DD>` (a note rides the CSV instead, which is why CSV is the format
  offered for Raindrop), so reading it is pure tolerance for what other apps
  write; a note is also the one field in a bookmarks file the user TYPED, which
  is what made dropping it silently worth fixing. The projection truncates to
  `LINK_NOTE_MAX`.
- **A source's "archived" is a LIST, not a folder.** Pocket's CSV `status`
  column lands as `ImportedLink.systemList` (→ `ARCHIVE_ID`), never as a folder
  named Archive, for the reason `systemList` exists at all: a folder chain
  `['Archive']` would mint a duplicate list on an account whose Archive has been
  renamed. Only the values a real export writes are matched (`archive`), and an
  unknown status stays a normal link — `trash` is deliberately never guessed,
  because that error files a live link as deleted.
- **HTML character references are decoded by the Netscape parser only**, because
  it is the only interop format that IS HTML: a browser writes
  `Kleppmann&rsquo;s blog` and `HREF="…?a=1&amp;b=2"`, so decoding is reading the
  format, not cleaning it up. It uses the same `decodeHtmlEntities`
  (`html/entities.ts`) as the two raw-HTML title parsers — see
  [link-extraction.md](./link-extraction.md), _three collectors, one meaning_ —
  and for the same reason: one table, so a title can't mean two things depending
  on which door it came in. **CSV and plain text must NOT decode.** Their fields
  are literal text (RFC 4180 quoting is the only escaping a CSV has), so a
  Raindrop title that really reads `Tom &amp; Jerry` means those characters, and
  decoding it would be the double-decode `cleanTitle` is forbidden from doing.
  A Brace.to export is JSON, likewise not HTML-escaped.

- Folder paths **find-or-create lists** by case-insensitive name walk, at the
  POSITION the path names: each segment is matched among the children of the one
  before it, so `Work/Specs` reuses a `Specs` that already sits under `Work`, and
  a `Specs` anywhere else in the tree is a different list. Trash never matches a
  folder name. Tags are the other shape — matched by name ALONE, wherever they
  sit, and minted at the root, which is what tag hierarchy not being a shipped
  entitlement looks like from here ([iap.md](./iap.md), the planned levers).

  **The tree is built on every plan, and `nestedLists` is not consulted.** It
  used to be: an unentitled account got the path joined into one root-level list
  named `Work/Specs`. That was silent, effectively permanent — the interop dedupe
  skips by canonical URL, so re-importing after an upgrade brings back nothing to
  re-nest — and inconsistent with the two other doors into the same state, since
  a backup restores `parentId` verbatim on any plan and a lapsed subscription
  keeps every nested list it made. The entitlement gates the CREATE affordances
  instead (the reparent gate in the lists editor, [editors.md](./editors.md)),
  which is where an action-triggered paywall belongs. A free account can hold a
  nested tree, cannot deepen it by hand, and can always flatten it — the same
  state a downgrade produces.

**Nothing that reads the list tree recurses.** A tree is as deep as its
`parentId` chain, and the chain is data this device does not choose. `useLists`
builds the tree in render and the lock provider reads it above every signed-in
screen, so a walk that took one call frame per level turned one deep chain into
a stack overflow on every launch — the chain is stored, so reloading reproduces
it, and the screens that could have removed it are under the provider that threw.
`buildTree` and every projection beside it (`sync/tree.ts`), lock coverage
(`sync/lock-coverage.ts`), the drop preview (`sync/tree-dnd.ts`), the library →
folder snapshot (`export/bundle.ts`) and the three interop serializers all keep
their own stack on the heap. The same rule reaches the components: both
sidebars render the tree as **flat rows** from `flattenToRows`, where they used
to render a component that rendered itself per level — identical markup, since a
row is indented by padding, but a React tree as deep as the list tree, which
React commits with a call frame per level. `buildTree`'s cycle cut went with it: it used to
re-walk the chain from every id, quadratic in depth, and now settles each entity
once while cutting exactly the edges the sorted scan did — which edge is cut is
part of the contract, since two devices must render the same tree, and
`tree.spec.ts` holds the old scan as an oracle.

**A row describes at most `TREE_ROW_MAX_LEVELS` levels** (32, `sync/tree.ts`).
Removing the recursion left work per ROW that still grew with depth, and paid
once per row it is the square of a long chain: every list picker handed each row
a copy of its whole ancestor chain and drew a guide line per level, in a list
that mounts every row. A 10,000-deep chain held 600 MB of ancestor names before
anything was drawn — so the app launched, and the bill came when a picker opened.
`flattenToPathRows` now names the first 32 ancestors and then `TREE_PATH_CUT`
(the rows past the cut share one array), the share sheet's picker rebuilds its
paths under the same bound, and both platforms' guide lines stop at 32. It is a
bound on what a row **shows** — the row keeps its true `depth`, and the forest
is untouched, which is where [locks.md](./locks.md) says a display limit has to
live — and 32 guide lines are 768px of indent, wider than any picker, so a row
with 32 ancestors or fewer looks as it did. A deeper row does read differently.
Its path label — a filtered picker row, `ListSelect`'s trigger and the
accessibility label on it — names the first 32 ancestors and then the cut, so
the names left out are the ones NEAREST the row, its parent's among them, and
two lists with one name under the same deep ancestor carry one label. Its indent
stops at 32 guide lines, so it sits level with every other row that deep.
Display is all the bound reaches: a row is keyed and picked by its id, and the
picker's filter matches a list's own name, never the label.

What still grows with depth, each by up to the square of one long chain: the two
exports — the CSV writes a folder's whole path on every link row in it, and a
Netscape file indents every line by its folder's depth — which are an export the
user asked for, not a screen that opens on its own; the web Lists settings
table, which is a screen, and works out `forbiddenParentIds` for every row it
shows on every render, each call walking the forest to the row and then the
row's whole subtree; and the marketing site's converter, which copies a path per
folder of a backup's list tree before its depth rule can refuse it.

**A list's identity is its path, and a forest holds one node per id.** Depth was
one number the data chose; the node count was the other. `buildTree` resolves
parents by id, and the ids it was handed were the plaintext copies, which
nothing made unique: the store is keyed by path, a restore and a pull both write
what arrives, and two records under different paths could carry one id. Each was
then a child of that id's parent **and** a parent of everything naming it, so
every copy of a level got its own copy of the level below — twenty stored lists,
two to an id and ten deep, built two thousand nodes, and each further level
doubled it. It is the same shape as the stack overflow above (stored, rebuilt in
render, above every signed-in screen) and none of that section's bounds touch
it: it is neither deep nor one long row. Three rules now hold the line, each at
a different edge:

- **The read edge takes the id from the path.** Both platforms' `readLists` and
  `readTags` hand each entity back under `idFromPath` of its path
  (`pathIdentifiedList`/`pathIdentifiedTag`, `sync/items.ts`) — for lists
  _before_ `mergeSystemLists`, because that merge is by id. Paths are unique, so
  ids are; a record stored anywhere else is no longer taken for a system list's
  override, and the one stored at a system id is that override whatever it calls
  itself. This is the rule `sync/paths.ts` already stated for every namespace and
  links already followed (`linkIdOf`); lists and tags were the two that carried a
  copy and went by it.
- **`buildTree` places each id once** — the last item holding it, the one
  parents were already resolved against — so a forest is never larger than the
  set it was built from. Nothing stored is hidden by this, since the read edge
  has already made stored ids unique; it is the backstop for a set that never
  went through one, which today is the marketing site's converter reading a
  backup that repeats a line.
- **The backup reader refuses a line whose two ids disagree** (above), which is
  what keeps such a record from being stored and pushed in the first place.

What the read-edge rule changes is confined to a record whose two ids already
disagree, which nothing in this app writes — but for such a record it is not
small. Whatever named its **old** id is dangling from then on and is read the
way a dangling reference always is: a child naming it as `parentId` is a root; a
link naming it as `listId` shows under no list (the list reads as empty) and
exports under My List; a link naming it in `tagIds` loses that chip, and the
tag's name in an interop export; a selection naming it in a URL falls back to
home. And a **list lock** keyed by it covers nothing, so the lock provider
sweeps it and what it gated is readable and exportable again — the list, the
lists that were nested under it, and the links still naming the old id, which
locking the list again does not re-cover ([locks.md](./locks.md), _Keying_, has
the whole of it). Nothing is rewritten on read; the next edit of the record
writes the path's id into its plaintext, and until then a client on an older
build still goes by the copy. A pin and an extraction carry the same kind of
copy, and neither is part of this rule — the backup reader compares the two ids
of a list or a tag and of nothing else. An extraction is fetched by path. A pin
is still read by its copy, in three places on each platform: the pinned overlay
resolves the pin's link through it (`readPinnedOverlay`), pin reordering finds
the moved pin and its neighbour by it (`usePinMutations`), and the bulk-edit bar
splits a selection into pinned and unpinned by it.

Only the platform-bound half of that lives in each orchestrator (the store
reads, the zip library, the file API). The rest is shared, so the two can't
drift: the archive contract is `data/backup.ts` (above), the outcome/progress
vocabulary and the quota gate are `data/import-run.ts` (export's vocabulary is
its sibling `data/export-run.ts`), the format→parser dispatch is
`import/parse.ts`, the rows→entities projection is `import/project.ts`, and
the folder/tag find-or-create walks are `import/resolve.ts` — the last two take
`newId` as an argument, since id minting is the one genuinely
platform-specific piece (`web-crypto` vs. `expo-crypto`, neither reachable
from `shared`).

### the import's quota gate

The gate runs at the same moment for every format — after the parse and the
dedupe, before the first write — but it ends in one of two different places, and
which one depends on what kind of file it is.

**An interop file asks.** `resolveImportQuota` (`data/import-run.ts`) hands the
counts to an `onQuotaPrompt` resolver and **suspends the run on the answer**:
take the first `room` links, or cancel (which throws `ImportQuotaError`, exactly
as the gate always did). Both orchestrators thread the resolver down from the
hook, where the `quota` phase parks the pending promise in a ref and the Data →
Import view renders the two buttons. Nothing has been written when the question
is asked, and nothing is written if the user backs out — including on the zip
branch, where the reader is deliberately held open across the prompt because it
reads an in-memory blob.

**Cancelling is silent.** The error the cancel path throws is how the answer
reaches the orchestrator, not something to show: the hook (`use-import-all-data`,
both platforms) flags the answer and drops the view straight back to `idle`,
skipping the error phase. Reporting it would flash a spinner and then announce
`role="alert"` "Import failed: …" — restating, as a refusal, the counts the user
had just read and declined to act on, for a run in which nothing happened. The
choice card unmounting is the feedback, and there is no receipt because there is
no event; `idle` renders nothing, as it does before any import. The flag is
scoped to that one answer — the gate's own refusals (no room at all, no resolver,
a backup file) still surface as errors.

Leaving the import screen also settles an unanswered prompt as cancellation,
including a prompt reached after the screen has already unmounted. An abandoned
promise must not retain the archive or a live-read hold. Expo holds live reads
only during the actual writes, after parsing, projection and the quota answer.

**A run belongs to the app, not to the view.** Leaving Import (its back link,
another Settings section, popping the screen on mobile) unmounts the hook but
not the orchestrator, which keeps writing. So the run's state is module state in
`use-import-all-data` (both platforms): a view opened mid-run shows its progress
and then its receipt, and `run` refuses a second import while one is in flight.
When the state lived in the hook, the reopened view read `idle` and offered the
picker again, and a second interop run deduped against a library the first had
not finished writing, so everything the first still had to write landed twice.
A receipt is shown once: to the view that watched the run finish or, if none
did, to the next one. `DATA-IMPORT-WEB-003` (`e2e/web/data-lifecycle.e2e.ts`)
holds the api to keep a run in flight while the view is reopened.

**A backup is still refused whole.** `assertUnderImportQuota` survives unchanged
on the bracemark-backup path, and that path never prompts. The old reasoning — a
partial import is indistinguishable from a corrupt one at the far end — is
_true of a backup_ and only of a backup: restoring 200 of 1,200 links leaves the
lists, pins and extractions in the archive pointing at 1,000 links that aren't
there, and the whole promise of a backup is that restoring it returns you to a
known state. An interop file is a **migration**, not a restore; "some of it, and
here is the number that didn't fit" is a coherent thing to want, and the far end
is a library the user is watching fill up.

Why it became a question at all: the cap and the invitation to bring an existing
library are in direct tension, and the import is the one moment they meet — a
free account pointed at a 1,200-link Raindrop CSV is exactly the user the import
path is _for_. The file is parsed on the device either way, so the exact count is
known while nothing has happened yet; spending it on a decision rather than a
refusal costs nothing and is the difference between a route and a wall. The
truncation is deliberately dumb (the first `room` surviving rows in file order,
after dedupe) because any cleverness would be us guessing which of someone's
bookmarks matter, and a wrong guess is invisible to them.

Two consequences worth stating where they're read rather than inferred, which is
why they're on the marketing site's `import-over-cap` and `free-cap` answers as
well as here:

- **A truncated import is resumable.** Interop dedupes by canonical URL against
  the library, so re-importing the same file after upgrading brings in the rest
  and skips what's already there. `ImportOutcome.notImportedCount` carries the
  number, and both Data sections lead the receipt with it.
- **Being over the cap is not a lockout.** `useLinkQuota`'s `atLimit` is
  `count >= max`, so an account that lands above the cap (a lapsed trial, most
  realistically) keeps reading, searching, editing, deleting and exporting — only
  new links stop. The `maxFiles` / `maxBytes` ceilings underneath **are**
  server-hard, and a library above one of those is read-only-plus-delete until
  it comes down — but a lapsed trial can no longer get there, because those two
  ceilings are sized by the account's high-water plan rather than its current
  one. A library imported under Plus stays writable after the trial ends; what
  ends is the ability to add to it (`bracemark-api` `lib/quota.ts`, and
  [iap.md](./iap.md) _enforcement_).

### importing from Brace.to

Brace.to is this project's predecessor, so its export is the one interop input
that is a **foreign app's whole backup** rather than a bookmarks file: a `.txt`
holding a pretty-printed JSON array of `{path, data}` — a raw dump of its Gaia
files across six path families (`links/`, `sslts/`, `pins/`, `tags/`,
`settings…`, `images/`). Import only; nothing exports _to_ Brace.to.

It gets its own parser (`import/brace.ts`) rather than a tolerant reading of the
text one because three properties of that layout make URL-scraping actively
wrong:

- **history.** A Brace id is `<addedDT>-<r4>-<r4>` with an optional fourth
  `<updatedDT>` segment, and an edited link keeps _every_ revision as its own
  file. They share a "main id" (the first two segments); only the greatest
  `updatedDT` is live. Import them all and a much-edited link lands five times.
- **indirection.** A link's list is whatever its newest `sslts/` entry says —
  not the `listName` in its own path, which is only where it was first filed.
- **opaque names.** The `<listName>`/`<tagName>` path segments are ids; the
  display names live in the newest `settings…` file's `listNameMap`/
  `tagNameMap`.

Detection is a **structural probe** over the head of the file (a leading `[`
then a `"path"` key naming one of the six namespaces), not a `JSON.parse` —
detection runs on every import and this file can be tens of MB. It is checked
_before_ the Netscape `</a>` test, since a stored page title can contain any
markup the page's `<title>` did. This ordering is what closes a silent failure:
Brace names its export `.txt`, so it used to sniff as plain text and the URL
regex mined the raw JSON — every dead revision, every `extractedResult` image
URL, every favicon — producing a plausible-looking mess rather than an error.

What crosses, and what deliberately doesn't:

| Brace.to                             | Bracemark                                     |
| ------------------------------------ | --------------------------------------------- |
| `url`, `addedDT`, id's 4th segment   | `url`, `createdAt`, `updatedAt`               |
| `custom.title`                       | **`customTitle`** — deliberate                |
| `extractedResult.title`              | `extraction.title` — provisional              |
| `custom.image` (`cdroot/images/…`)   | a `files/{id}.enc` blob + `customImageId`     |
| list `My List` / `Archive` / `Trash` | `MY_LIST_ID` / `ARCHIVE_ID` / `TRASH_ID`      |
| any other list                       | folder path of display names, find-or-created |
| tags (ordered by rank)               | tags, find-or-created                         |
| pins (LexoRank)                      | pins, re-ranked into this library's keyspace  |
| `extractedResult.image`/`favicon`    | **dropped**                                   |
| `decor`, every non-name setting      | **dropped**                                   |

Brace is the **one source that keeps both titles**, and it earns the split:
it draws the deliberate/discovered line in exactly the same place we do, so
`custom.title` joins every other format's title in `customTitle` while
`extractedResult.title` stays provisional, instead of the two being
flattened. `extractedResult.image` is dropped because it's a remote URL while
our `extraction.imageId` is a _downloaded_ blob — and fetching at import would
announce the user's whole library to every host in it. Writing no facets leaves
each link pending, so our own extractor derives a real image and may upgrade the
title. Settings beyond the two name maps are another product's preferences, and
`doExtractContents` is worse than noise: it's a privacy consent, which has to be
given here rather than inherited.

The system lists are carried as **named ids, not matched names**
(`ImportedLink.systemList`): resolving `['Archive']` by name would mint a
duplicate on an account whose Archive has been renamed, and `ListResolver`
deliberately refuses to match "Trash" at all — right for a bookmarks folder with
that name, wrong for a real one. Brace's mobile export writes an absolute
on-device path for image blobs instead of the `images/<fname>` key its own
importer expects; we re-key off the `images/` tail so a phone-made export isn't
silently stripped of every custom image.

Custom-image blobs are written **before** the links that name them (content
before metadata — a run that dies between the two leaves an unreferenced blob,
never a link pointing at bytes that never arrived), and stored **verbatim**: a
restore or migration keeps what it's given, and only a fresh pick in the editor
goes through `resizeImage`. The whole export is one JSON string parsed at once —
the same in-memory ceiling the bracemark backup has on mobile, failing loudly
rather than guarded, so a very large library wants the desktop app.

The Bracemark backup restore follows the same content-before-metadata order on
both platforms. Previously its file phase came last: a failure there left the
owning entities present, so retry skipped those entities and never revisited
their missing files. The export/import suites interrupt the file phase, retry
the archive, and verify that links and files are restored together. They also
inject a concurrent write after the existence scan to prove it survives.

### importing from Raindrop.io

Raindrop exports a library two ways, and both import: its **HTML** is a Netscape
bookmarks file (`netscape.ts`, detected like any browser's) and its **CSV** is
the header-driven one `csv.ts` reads. What each carries that neither format has
a standard slot for is read by both parsers through one module,
`import/raindrop.ts`, so the two files of one library import to the **same
rows** — which is exactly what `import/raindrop-exports.spec.ts` asserts, over
one real library exported both ways (`import/__fixtures__/raindrop`; see
[testing.md](./testing.md), _import specimens_). Every rule below was read off
that pair, not off Raindrop's docs, which disagree with its own export about
the folder separator.

| Raindrop.io                                   | Bracemark                                            |
| --------------------------------------------- | ---------------------------------------------------- |
| title                                         | **`customTitle`** — renamed or not, it can't be told |
| note (HTML `<DD>`, CSV `note`)                | note                                                 |
| highlights (`<DD><blockquote>`, `highlights`) | folded into the note as `> ` quotes, after the note  |
| favorite (`DATA-IMPORTANT`, `favorite`)       | the tag **Favorites**                                |
| collection, nested                            | folder path, find-or-created                         |
| **Unsorted** (its inbox)                      | the default list — no folder                         |
| tags, created, (HTML only) last modified      | tags, `createdAt`, `updatedAt`                       |
| cover, excerpt, highlight colours             | **dropped**                                          |
| Trash                                         | not in either file — Raindrop leaves it out of both  |

- **The title is the user's.** The specimen holds a link the user renamed in
  Raindrop; both files carry the new name exactly as they carry a fetched one,
  with the page's real title visible only in the CSV's `excerpt`. As a
  provisional title it would have been overwritten on the first extraction. This
  is what moved the rule for every interop format (_import_, above).
- **Highlights go into the note** because a link here has one note and a
  highlight is text the user chose to keep. The typed note goes first, so the
  `LINK_NOTE_MAX` truncation cuts the page's words before theirs. The HTML writes
  the note's `<DD>` and then one `<DD>` per highlight; before these were read the
  first `<DD>` won, so highlights vanished — and on a link with no note, the
  first highlight became the note. A note _on_ a highlight is a paid Raindrop
  feature the specimen doesn't have, so how either file writes one is unknown.
- **A favorite is a tag, not a pin.** A pin is a short ordered shelf; a Raindrop
  library can hold hundreds of favorites in no order. Tags resolve by name, so an
  existing Favorites tag is joined, not duplicated.
- **Unsorted is matched by name, only at the top, only in Raindrop's file** —
  its `<TITLE>` in the HTML, its `excerpt` column in the CSV. A name match is
  what `systemList` exists to avoid, and it is safe here only because nothing is
  looked up by it: the target is the default list, which the empty path names by
  position, so there is no renamed list to miss and none to duplicate. A
  browser's folder called Unsorted is still the user's. The HTML also dates
  Raindrop's `0`, but reading that would let the two files disagree, so neither
  does — the cost is a collection the user named Unsorted landing in the
  default list too.
- **The CSV is the lossy one.** It joins a nested path with `/` and writes each
  name as-is, so a Raindrop CSV is split on the padded separator only — a
  collection named `AEO/GEO` survives — but one named `SEO / AEO` becomes two
  lists, and nothing in the file can say otherwise. The HTML nests with `<DL>`s
  and loses nothing; it is the better file to import. (Our own CSV and the `a/b/c`
  shape Raindrop's import docs describe still split on a bare slash.)

### the sign-out teardown — close the gate, then wipe

Every local wipe in this document funnels through one client primitive: the
teardown in each platform's `contexts/auth-provider.tsx`, which runs
`clearSession`, then `clearData`, then `queryClient.clear()`, and then flips auth
state. Exactly three things end here: a deliberate sign-out (`endSession`, for
the generation whose token it sent), the last step of delete-account (also
`endSession`, for the deleted account), and a `session_revoked` verdict for the
session generation this device still holds. Each is decided under the lock
against the persisted record, so a slow answer that finds a replacement there — a
resume, another account — ends nothing. An expired or unknown session does NOT —
it keeps everything and pauses sync. That rule, and why, is
[sessions.md](./sessions.md)'s. On web the teardown runs under the cross-tab
lifecycle lock and announces itself to the other tabs, which close their UI
without wiping twice; `clearData` also drops any query-keyed entry from the
service worker's runtime caches — a safeguard, since none is written today
([offline-mode.md](./offline-mode.md), _sign-out leaves the worker alone_).

The order inside it is load-bearing, and it is **three** steps, not two:

| step |                                            | why it can't move                                                                                                                                                 |
| ---- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `clearSession`, then `setStatus('ending')` | the record goes first, so an interrupted wipe is finished by the next load; then the gate closes — the app subtree unmounts **before** the store empties under it |
| 2    | `clearData`, `queryClient.clear()`         | the actual wipe, with nothing mounted to observe it                                                                                                               |
| 3    | `setStatus('unauthenticated')`             | releases the exit navigation, now that the wipe has finished                                                                                                      |

The record and the wipe fail differently. If the record can't be deleted, the
teardown stops there: the library and the signed-in state stay as they were, and
an explicit caller (sign-out, delete-account) gets the error — wiping under a
record that survives would have the next launch adopt a session over an empty
library. (The in-memory mirror follows the durable delete, never leads it.) If
the wipe fails after the record is gone, the teardown still reaches
`unauthenticated` and the next load finishes it — except inside `setSession`'s
account switch, which throws rather than adopt a new account over residue; a
retry finds no session and wipes first. On web the table wipe is one Dexie
transaction that includes the ownership row (`syncMeta`), as the SQLite wipe
already was, and every local write checks that row inside its own transaction —
so a write either lands before the wipe and goes with it, or finds no owner and
fails (the account fence, [sessions.md](./sessions.md)).

"Nothing mounted" in step 2 means the signed-in subtree, and on expo it is not
literally nothing: the root `ThemeProvider` sits above the auth gate and reads
`items` and `local_settings` through `useSettings`, across the wipe. `clearData`
there is bare whole-table deletes, which SQLite truncates without the
`sqlite3_update_hook` events `useLiveRead` listens for
([client-queries.md](./client-queries.md)), so it calls `invalidateLiveReads`
for every table it emptied, as delete-all-data does. Without that the provider
kept the signed-out account's theme pinned over the landing — and into the next
account signed in from the same process — until a relaunch read the empty rows.
Web needs no counterpart: Dexie's liveQuery observes `clear()`.

#### what an empty table does not mean — expo

`clearData` on expo is checked by a spec that counts every table and every file
under the app's own directories, and a wipe can pass it while the account is
still readable on the device four ways. None of them is visible from inside the
store — the app looks empty, the next account inherits nothing it can query —
which is why each one shipped.

- ⚠ **Deleted rows stay in the database file.** A `DELETE` unlinks pages; SQLite
  moves them to its freelist with their bytes intact (expo-sqlite's build sets
  no `secure_delete`), and the WAL keeps every frame written since its last
  reset. So `clearData` finishes with `scrubFreedPages` (`data/db.ts`):
  `VACUUM`, then `PRAGMA wal_checkpoint(TRUNCATE)`. **Both, in that order** —
  in WAL mode the rebuild lands in the WAL, so `VACUUM` alone leaves the old
  file as it was, and the checkpoint alone leaves the freelist.
  `clear-data.residue.spec.ts` reads the raw bytes of both files and fails on
  either half by itself. It is best-effort and never throws (the rows are gone; a
  failed scrub must not fail a finished sign-out), and the no-session branch of
  the next launch runs `clearData` again, which retries it. Delete-all-data runs
  the same scrub. Not a pragma at open: `secure_delete` would zero pages on
  every ordinary delete and still leave the WAL, and what must not outlive an
  account is the account, not each edit. Beyond any file API: a wear-levelled
  flash block that still holds an old page.
- ⚠ **The OS cache directory holds plaintext nothing else reaches**, because a
  file goes there when some other reader needs it for a moment and the OS only
  cleans up under storage pressure. `data/cache-files.ts` owns all of it: the
  **export** (the whole library in one file — written under
  `bracemark-exports/<run>/`, replaced only after the next run writes successfully,
  since it must outlive its own
  run for the share sheet and the receiving app to read it), the **import's
  picked copy** (`copyToCacheDirectory`; deleted when the run settles, as the
  run has read it whole), a **custom image's picked file and resized copy**
  (kept until sign-out — the editor's draft points at the uri, and a save that
  failed after the copy retries from it), and an **extraction's in-transit
  image** (`lib/device-extraction.ts` — the preview a saved page declares,
  parked for the native decoders; the worker deletes it when the write settles,
  but a process killed before then never runs that `finally`, so it is written
  under `bracemark-scratch/` rather than loose in the cache dir, where the
  leftover had a name nothing knew). `clearData` sweeps all four. The sync
  plane's in-transit files (`newTempEncFile`) share `bracemark-scratch/` and go
  with it: they are ciphertext, so the sweep owes them nothing, but everything
  this app names in the cache directory is then in a directory the sweep lists.
  There is **no launch-time sweep**, on purpose: it would buy no privacy (a
  signed-in device holds the same previews decrypted, and a launch with no
  session already runs `clearData`), only disk the OS reclaims from a cache
  directory anyway — and it would have to run before the first transfer starts,
  an ordering nothing enforces.
  ⚠ The picker directories are named by the expo modules that write them
  (`DocumentPicker`, `ImagePicker`, `ImageManipulator`), so **an SDK bump can
  move one and the sweep then deletes a directory that is not there** — no
  error, no failing test. A dev build says so at the next pick: each uri a
  picker or the manipulator hands back goes through `warnIfNotSwept`, which
  logs when the file is not inside a directory the sweep deletes. That covers a
  moved directory and nothing else — a writer that never hands back a uri is
  invisible to it — so re-read the three names from the modules' native
  sources when any of them is upgraded
  ([expo-dependencies.md](./expo-dependencies.md), _expo-image-picker +
  expo-image-manipulator_). On a device the question is asked the other way
  round, of every file rather than of the listed ones:
  `SIGN-OUT-RESIDUE-NATIVE-001` ([e2e.md](./e2e.md), _scale, loading and
  offline_).
- ⚠ **The platform's HTTP cache lives in that directory too, and no sweep
  reaches it** — React Native's OkHttp cache on Android (`cache/http-cache/`),
  the URL cache on iOS (`Library/Caches/<bundle id>/Cache.db`). It is not ours
  to delete: the networking stack holds it open, and it is named by the
  platform. So what must not outlive an account is kept out of it at the
  source — **bracemark-api marks every response `no-store`**
  ([api-contracts.md](./api-contracts.md), _no response is cacheable_). Before
  it did, Android's cache kept the api's GETs after a sign-out, the username in
  a request URL among them; `SIGN-OUT-RESIDUE-NATIVE-001` found it by listing
  what a signed-out device still held, and now carries the username as a marker
  there. A blob is R2's response rather than the api's, so its `no-store` is
  asked for in the presigned URL (same section). What still lands in that cache
  is whatever a saved site's own response allows — a page, a preview image, a
  favicon — and, on an iOS **dev** build, everything, because the dev client's
  network inspector stores every response regardless (same section).
- **Work in flight when the wipe lands writes after it.** The sync cycle was
  already fenced on the account's ownership row
  ([sessions.md](./sessions.md)); two writers were not. The **favicon cache**
  has no owner column and both its fillers write after a network round trip, so
  `putFavicon` / `putFaviconNone` now take the username and check the row inside
  their own transaction, ahead of the file write — and `FaviconProvider`'s drain
  ends when the provider unmounts, where it used to run on through the queue,
  one request per host to the signed-out account's saved sites
  ([link-extraction.md](./link-extraction.md), _favicons_). The **export** holds
  the gathered library in memory for minutes, so its one write is fenced the
  same way: a sign-out midway used to end with the backup written after the
  sweep.
- **Decoded previews stay in memory.** expo-image's memory cache holds what was
  on screen, and belongs to a module `@stxapps/expo-react` does not depend on,
  so the app layer drops it: `SignOutProvider`'s unmount cleanup calls
  `Image.clearMemoryCache()`. An unmount cleanup rather than a step of the
  sign-out, so a revocation and a delete-account run it too.

Delete-all-data deliberately keeps **one** member of that set: the cache
directory. The export in it may be the backup the user took a minute ago
_because_ they were about to delete everything, and the app they sent it to can
still be reading it. After a sign-out the server has the library; after
delete-all that file may be the only copy.

#### the press, and the wait

A sign-out from a menu or a lock pane goes through a hoisted `SignOutProvider`
(`requestSignOut`), not the bare `useSignOut` mutation — bracemark-web's links
menu and lock pane and the browser extension's options page through
`@stxapps/web-ui` `contexts/sign-out-provider.tsx`, bracemark-expo's through its
own `contexts/sign-out-provider.tsx`. Three reasons, all about the stretch
between the press and step 1:

- **It syncs first when a change hasn't.** The wipe takes the pending queue, and
  a queued change exists nowhere else — the reason "Use a different account"
  already warned ([sessions.md](./sessions.md)). The count is read at the
  press. With nothing pending there is no question: the library is on the
  server, and a dialog on the commonest path teaches people to press through
  the one that matters. With something pending the flow runs one sync cycle
  (`useSync().syncAndWait`), reads the count again, and signs out with no
  question if the queue emptied. The wait is named in the dialog, can be
  cancelled — nothing is erased during it, and a cancel ends that sign-out even
  if the cycle then lands — and is bounded by `SIGN_OUT_SYNC_TIMEOUT_MS` (15 s,
  `@stxapps/react` `lib/sync-before-sign-out.ts`): an offline cycle gives up by
  itself inside nine seconds, and the bound is for the connection that accepts
  a request and never answers.
- **It asks about what the sync could not save.** Still pending after the cycle
  — offline, an expired session (which runs no cycle at all), an account over
  its limit — and the dialog asks, with the count that is left. The second read
  is the answer rather than the cycle's outcome: a cycle can fail after pushing
  everything, and complete with part of the push refused.
- **It covers the app while the sign-out runs.** The revocation request goes out
  before anything is erased, so the app behind an already-closed menu stayed
  usable for as long as the network took, and whatever was saved then was
  erased a moment later. The cover has no way out while the request is in
  flight. Because it has none, the endpoint's contract caps that request at
  `SIGN_OUT_TIMEOUT_MS` (10 s) instead of the client's 60 s default
  ([api-contracts.md](./api-contracts.md), _deadlines_); when the cap fires the
  cost is the one a failed request already had — the session row is not
  revoked, idles out and is purged.

If the pending-count read fails, the flow syncs all the same and reads again;
if that read fails too, the dialog warns that unsynced changes could not be
checked and requires confirmation. An unreadable queue is not an empty one.

The flow used to ask at the press and end "cancel and sync first". Every caller
but one could do that, and none should have had to — it is advice the app can
take itself. The one that could not is the **app-lock pane's "forgot the
password" link** ([locks.md](./locks.md)): signing out is the only way past a
forgotten app lock, and behind that pane there is no sync to press and no app to
cancel back to. On bracemark-expo it was worse than a dead end, because nothing
there runs a cycle on its own after a relock — cycles start when the store
becomes ready, on a local write, and when the user asks for one (Sync, pull to
refresh) — so a queue left by an offline edit stayed queued behind the lock for
as long as the app stayed alive, on a device that was back online. The question now says
"try again later", which is true from the pane too: the next press of the link
is the retry.

The cycle comes from the sync context, so the provider sits INSIDE `SyncProvider`
(the browser extension's `ExternalSyncProvider`, whose `syncAndWait` is the
background's `KICK_SYNC`, answered only once its cycle has settled) and still
above `AppLockGate`. It goes through the context rather than calling the engine
because the extension's cycle is a selective one that only its worker may run,
and because the indicator then reports this cycle like any other.

A pending-count or sync result is ignored after its provider unmounts, its
account or session generation changes, or its flow is cancelled. A same-account
resume replaces the generation too: an old flow releases its cover and latch
instead of signing out the resumed session. Confirmation and retry also check
the flow's generation, and pass that target into `useSignOut`; the mutation
checks it again before sending a revocation request, covering a replacement
between the event handler and TanStack starting the mutation.

A successful mutation also closes the dialog if the tree stays mounted: another tab may have resumed the session while the
old sign-out request was out, so generation fencing preserves that session
without unmounting this provider.

A failed sign-out — the session record could not be deleted, so nothing was
erased — now says so in that dialog; it used to reject into nothing.

On web the provider sits under `AuthGuard`, inside `SyncProvider` and above
`AppLockGate`, as on expo.
The gate's `'ending'` unmounts it with everything else, which is what takes the
dialog down on success.

#### what the wipe cannot reach — web

`clearData` on web runs in **one tab**, and two things are out of its reach for
that reason or a near one (two more, further down, for a different one):

- **`sessionStorage` is per tab.** bracemark-web keeps one key there, the links
  view Settings' ✕ returns to (`lib/links-return.ts`), and it can carry a
  search — which, unlike a previous account's list or tag id, resolves for
  anyone. So each tab drops its own when the account that browsed it stops
  being the one signed in (an effect in the root layout's `Initializer`, comparing
  the previous username with the current one). Initial hydration from no username
  to an account preserves the saved view across a reload. ⚠ Not from `AuthGuard`,
  though it is the obvious place: its
  exits `redirect()` during render, and a render that throws commits no
  effects.
- **The installed app does not leave.** A browser tab's sign-out navigates off
  the origin and the document dies, taking every in-flight request with it.
  Installed, `AuthGuard` goes to `/sign-in` in place and the document lives on —
  so work in flight at the wipe is the same hazard there that it is on expo.
  The favicon queue is the instance that existed: `FaviconProvider`'s drain now
  ends when it unmounts, and `putFavicon` / `putFaviconNone` are fenced on the
  account's ownership row ([link-extraction.md](./link-extraction.md),
  _favicons_).

Two more places are out of its reach for a different reason: they are **the
browser's storage, not the app's**, so no teardown can clear them and the only
lever is to keep things out. Both were found by reading a Chrome profile from
disk after a sign-out, not by anything the app could observe.

- ⚠ **The HTTP cache.** A response that says nothing about caching is one the
  browser may keep, under its request URL: the api's GETs were there —
  `password-door?username=…` among them — and so was every presigned blob read.
  bracemark-api now marks its own responses `no-store` and asks R2 for the same
  on a blob ([api-contracts.md](./api-contracts.md), _no response is
  cacheable_, with the before-and-after counts). bracemark-extractor does too:
  its image proxy used to ask the browser to keep each preview and favicon for
  a day, under a URL naming the saved site.
- ⚠ **The form history.** A browser keeps what is typed into a field it thinks
  worth completing, and offers it to whoever types there next: the add-link
  dialog's URL and the edit dialog's Title were both in the profile's autofill
  table, beside the username. So every text field is `autocomplete="off"`
  unless it names itself as a credential, applied by the input primitives
  rather than at each call site
  ([accessibility.md](./accessibility.md), _what a field tells the browser_);
  after it, that table held the username alone. The username stays on purpose —
  it is the sign-in form's `autocomplete="username"`, which is what a password
  manager fills.

What web cannot do at all is scrub: IndexedDB offers no equivalent of `VACUUM`,
and a cleared store is compacted on the browser's schedule, not ours. The same
profile shows it: after the sign-out the origin's IndexedDB log file still held
the username, the saved link and a list's name — records the app had already
deleted. The only lever is deleting the whole database rather than clearing its
tables, which would mean rebuilding the teardown around other open tabs and
around the ownership check that today runs inside the clearing transaction.

Step 1's gate is the one that isn't obvious. Without it there is a live frame
where the store is already empty but status is still `authenticated`: the
signed-in subtree stays mounted, every liveQuery re-fires against a wiped
database, and **every user list and tag disappears at once while the app believes
it is signed in**. Anything that reacts to data _disappearing_ then misfires on
what looks like a mass delete.

bracemark-web hit this in its sharpest form. The links page keeps its selection in
the URL, so on `/links?list=<id>` the wipe made page-provider's `isStaleSelection`
read a live view as a deleted one, and it did what it does for a genuinely deleted
list: `router.replace('/links')` — straight into `AuthGuard`'s own exit navigation,
one frame apart. Two navigators, and the render crashed hard enough to take the
pending navigation with it, leaving the user signed out on the page they were
trying to leave. Any user-list or user-tag view was affected, including the
locked-list pane, whose "sign out" is the documented way past a forgotten lock
password ([locks.md](./locks.md)).

Note what step 1 is **not**: flipping straight to `unauthenticated`. That would
also unmount the subtree, but it starts the exit navigation immediately, and on web
that is a cross-origin `location.replace` — a document teardown racing a wipe that
still has decrypted bookmarks in IndexedDB. `'ending'` buys the unmount without the
navigation. (The mount-time guard in `AuthProvider` re-runs the wipe on the next
load precisely because an interrupted one is possible; don't spend that budget
here.)

The invariant this leaves behind, and the reason it lives in the state machine
rather than in the component that misfired:

> **While a sign-out is in flight, only the auth gate navigates.** Every gate
> (`AuthGuard`, `GuestGuard`, `HomeRedirect`) treats `'ending'` exactly like
> `'loading'` — render nothing, decide nothing. Nothing else is mounted to route,
> so an automatic navigation anywhere under the gate is safe by construction,
> not by discipline.

The second, independent defence sits in `AuthGuard` itself: the cross-origin exit
leaves by `window.location.replace` in an effect rather than `redirect()`, keeping
Next's router out of its MPA branch entirely — see that file's header for the
failure mode, and [hosting.md](./hosting.md) for why sign-out is the one navigation
that leaves this origin. Keep both; they're cheap and they fail independently.

Coverage, stated exactly, because the two halves are not equally testable:

- `e2e/web/account.e2e.ts` signs out from a **user list**, and that shape is
  load-bearing — measured, not assumed. Against the original `redirect(SITE_URL)`
  the spec fails; the same spec on bare `/links` **passes**, because that selection
  is My List, a system list `readLists` always merges in, so it can never look
  deleted. So the spec pins the `location.replace` half, and it needs a real router
  plus a real IndexedDB wipe to do it — no jest/vitest layer can stand in
  ([e2e.md](./e2e.md)).
- The invalidated-session path — a real 401 on an open page — is
  `SESSION-INVALID-WEB-001` in the same spec: the local store must count empty and
  the page must land on `/sign-in?next=`, not on the marketing site.
- The step-1 ordering has **no test, and can't have one today**. With
  `location.replace` in place the stray `router.replace` is absorbed — that is the
  whole point of keeping both defences — so removing `'ending'` breaks nothing
  observable _right now_. It is prevention against the class: the next automatic
  navigation added under the gate, or a future exit that goes back through the
  router, turns an unobservable ordering into a crash again. That is why the rule is written
  here, and flagged ⚠ in `CLAUDE.md`'s docs table, rather than asserted somewhere.

**Both platforms run the same three steps**, and the `'ending'` phase means the
same thing in each (`packages/{web,expo}-react/src/contexts/auth-provider.tsx`).
What it _buys_ differs, and it's worth being honest about that: on web it prevents
a crash, because the links page keeps its selection in the URL and therefore has an
automatic navigation to misfire. Expo keeps its selection in React state, so it has
no such effect and nothing there crashes — the phase buys the frame itself, where
the list would otherwise empty on screen a beat before the group unmounts. It is
still worth mirroring: the rule belongs to the state machine, and the platform that
drops it re-opens the frame for whatever it adds next. Two of expo's three guards
(`AuthGuard`, `GuestGuard`) test `'ending'` explicitly; the third, `HomeGuard` (the
landing's, at `/`), navigates on `'authenticated'` alone and renders nothing in the
other three, which is the same safety by a different route.

### delete all data — one server-side wipe, not a client delete loop

`POST /v1/data/delete-all` (contract in `@stxapps/shared` `data/endpoints.ts`,
route in `routes/data.ts`, logic in `services/sync.ts` `deleteAllUserData`).
The old Gaia-era client enumerated fpaths and deleted file-by-file because the
server couldn't be trusted with anything and had no bulk delete. Neither holds
now, and the client-driven loop is wrong on its own terms:

- **it can only delete what it knows about.** Orphans — `object-without-op`
  leftovers, blobs another device pushed that this one never pulled — survive
  it. The server sees the whole `/users/{uid}/` prefix; no client does.
- it would bloat the op log with thousands of `delete` rows and churn the
  pending queue through the engine's single-flight machinery, for minutes
  instead of seconds.

The server needs no content knowledge to do this (everything under the prefix
goes), so it doesn't strain the blind-broker stance — the envelope, not the
ciphertext, names what to delete.

**Ordering: DO first, R2 second.** This is the op-without-object invariant
("the log may lag R2 but must never point ahead of it") read in the delete
direction. Wipe the op log + quota map first (one `wipeAll` RPC — the DO's
serialized SQLite); then page `list()` + `delete()` over the R2 prefix
(1000-key pages, one subrequest each — a 100k-object library is ~200
subrequests in one invocation). A crash between the halves leaves only
objects-without-ops, which the fallback listing heals; the reverse order would
leave surviving put-ops 404ing every puller. Every step is idempotent, so the
recovery story is: the endpoint failed visibly → the user clicks again. The
paging is also why the endpoint declares its own client deadline
(`DELETE_ALL_TIMEOUT_MS`, 5 min, in its contract; delete-account shares it). The
response comes only after the last page, so the time grows with the account's
object count, and the 60 s default would report a failure for a wipe that is
still running ([api-contracts.md](./api-contracts.md), _deadlines_).

**Multi-device convergence is free — no epoch, no tombstones, no new sync
machinery.** The wiped op log answers the next incremental pull with `null`
bounds, which is already a routing row in the sync design: _cursor set, bounds
null → download-authoritative fallback_. The fallback lists the (now empty) R2
namespace and deletes every local path with no pending op. The one edge:
a device holding **unsynced pending ops pushes them back** (local-wins — the
same policy as every fallback, per "never silently discard the user's unsynced
work"). Accepted and written into the UI copy ("changes that haven't synced yet
may sync back afterward").

**The deleting device** (`web-react` `data/delete-all-data.ts`, over the
`useDeleteAllData` hook):

1. `awaitInflightSync` — wait out any in-flight cycle **without starting one**
   (a cycle that already read the pending queue could re-push ops after the
   wipe), then `clearPendingOps` — this device's unsynced changes are abandoned
   on purpose (pushing them first is work the wipe immediately undoes).
   The delete view names this as a separate **waiting for sync** step rather than
   claiming the wipe has started. A two-minute watchdog fails closed: if the
   cycle does not settle, the attempt reports an error before the queue, server,
   or local store is touched. It must never time out _into_ the next step.
   The per-request deadlines ([api-contracts.md](./api-contracts.md),
   _deadlines_) don't make it redundant. They guarantee the cycle settles
   _eventually_, and eventually has no bound a user can sit through: a cycle is
   many requests in sequence, each with its own deadline; a 429/5xx still retries
   through its Retry-After wait; a sync triggered meanwhile reruns inside the
   same in-flight cycle; and local store work has no deadline at all. The two
   minutes is one stalled call's deadline plus the retry client's longest single
   wait, derived from both (`DEFAULT_CALL_TIMEOUT_MS` +
   `DEFAULT_RETRY_MAX_DELAY_MS`), so moving either moves the watchdog. Giving up
   is cheap, so a longer cap would only lengthen the spinner: the watchdog
   cancels nothing, the cycle runs on, and a retry resumes the wait on it. The
   watchdog is applied HERE, at the flow, with shared's `withTimeout` — the
   duration and the user-facing line are a property of this destructive,
   user-blocking action, not of waiting. `awaitInflightSync` itself never
   rejects, and it also serves the browser extension's background worker, which
   has no UI to report a timeout to.
2. Call the endpoint, **naming the account** (below). Nothing local is touched
   until the server confirms.
3. Wipe the local **synced** stores: `items`, the decode cache, and `locks`
   (they guard lists that no longer exist — the same reset sign-out applies).
   On expo, the bare whole-table deletes then explicitly invalidate the affected
   `useLiveRead` tables: SQLite's truncate optimization does not emit the
   `sqlite3_update_hook` events Expo observes. Expo also scrubs the database
   file afterwards (`scrubFreedPages` — _what an empty table does not mean_,
   above), and deliberately does **not** sweep the cache directory. The successful hook also calls
   `requestSync`, whose local-write nonce makes a links screen still mounted and
   scrolled behind Settings promote the empty result immediately.
4. Reset the sync bookkeeping — cursor back to `(0, '')` with `firstSyncDoneAt`
   now, the row `seedNewAccount` writes. Semantically exact: an empty local
   store _is_ the complete snapshot of the wiped namespace, the same reasoning
   that lets create-account seed instead of pulling.

**⚠ The table deletes of step 3 and the reset of step 4 are one transaction,
fenced on the account, and the reset runs first because it is the fence.** The
transaction holds the reset and the deletes of `items`, `locks` and the
`favicons` cache (on expo the two junction tables too); the rest of step 3 — the
decode cache, and on expo the invalidation, the scrub and the file sweeps — runs
after it, and only if it committed. Step 2 pages the whole namespace and can be out for minutes, and
the session can end under it — on web another tab signs out, or signs in as
someone else. `items`, `locks` and `favicons` have no owner column,
so a local half that ran blind would empty the **next** account's library while
that account's cursor still said the store was complete (on expo, sweep its
files too), and then write the previous account's ownership row back beside the
new one — the row every stale writer of that account is fenced on
([sessions.md](./sessions.md), _concurrent requests and shared local state_).
So the reset is not `seedNewAccount`, which _creates_ the row: it is
`resetToSeededState` (`resetToSeededStateTx` on expo), which only rewrites a row
that is still there and throws `AccountFencedError` otherwise, run first inside
the transaction that wipes the tables. That transaction shares its scope with
the teardown's, so the two are ordered: this one lands first and the teardown
wipes what it left, or the teardown's clear lands first and this one finds no
row and throws with nothing touched — and on expo the file sweeps after it never
run. Nothing reports the unfenced version: the delete "succeeds", and the damage
is in an account that was not on screen.

The fence is the row, and the row is keyed on the username, not on the session.
Two orderings therefore still pass it, both on the starting account's own data
and neither reaching another account: the **same** username signs out and back
in while the call is out (the run wipes what the new session has pulled and
marks its first sync done), and a teardown whose clear failed after the session
record was gone, which leaves the row (the run wipes the leftovers; the next
sign-in must complete that clear before it claims, so the row cannot outlive
it). And `resetToSeededState` on web is a check followed by a `put`: "rewrites,
never creates" is a property of the transaction it is called in, not of the
function, where expo's is an `UPDATE` and holds on its own.

**⚠ The request names the account, and the server checks the name.** The body
is `{ username }` — the account the run was started for, captured at the click.
It does not pick the namespace: that is still the bearer token's, and the server
never takes a user id from a body. It is there because the token cannot say
whose data the user _meant_. The client attaches whichever session is current
when a request **leaves** (`lib/auth-api-client.ts` reads it then), and step 1
can wait two minutes before step 2 sends — long enough for the account to change
under the flow (on web another tab signs in as someone else and this one adopts
the session in place). Unbound, that request would carry the **next** account's
token and empty its namespace, irreversibly, on a confirmation the previous
account gave; the fence above would then refuse the local half, and that
account's devices would converge to empty through the fallback. So the route
resolves the name through the username directory and wipes only when it is the
session's own account (`assertSessionAccount`, `services/account.ts` — the
comparison the door rotations make, minus the proof), answering 409
`account_mismatch` otherwise with nothing touched. One answer for every way it
can fail — no such name, a deleted account's, somebody else's — so it says
nothing about which usernames exist.

The check is on the server because that is where the wipe is. A client-side
"compare the session, then send" is correct only while nothing between the
comparison and the token read awaits — a property of three files that no test
states and nothing would report the day one of them gains an `await`. A body
with no name is refused (400): a client from before the field fails closed
rather than wiping unbound. Two consequences of putting it in the contract: the
bind exists only on a server that has the route, so **the API deploys before the
clients** (an older server drops the field and wipes unbound, and the client
cannot tell); and the field is `usernameSchema`, the rule sign-in already
applies, so a name that rule rejects cannot send the request at all.

**An account change is its own outcome, not a failed delete.** Both flows throw
shared's `DeleteAllAccountChangedError` for the two ways a run can find the
account gone, and the hook turns it into the `account-changed` state:

| `serverWiped` | what happened                                                                                                                                   | what the view says                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `false`       | the server refused the name (the token at dispatch was another account's), or the hook refused the run before sending (the view's guard, below) | nothing was deleted; open the view again              |
| `true`        | the server wiped the account that asked, then the fence refused the local half                                                                  | that account's data is deleted; this device untouched |

"Nothing" in both rows is about the wipe: step 1 has already abandoned the
account's unsynced queue by the time either can happen.

It is terminal, like `done`: the button and the tick are disabled. The ordinary
`error` line — "nothing was removed from this device, please try again" — is
false for the second row and dangerous for both, because "again" would act on
whoever is signed in now.

The view carries a second, weaker guard of its own: the hook remembers the
account it was **opened** for and refuses a run while `username` is any other,
so a tick given under one account, or a retry offered to it, does not start a
wipe for the account that replaced it. Captured at mount rather than at the
first run — by then the tick may already be the previous account's. It is a
guard on the view, **not the bind**, and it is weaker in two ways: it compares
names, so a view opened for A is live again after A → B → A with whatever tick
it held; and it reads React state, which trails the session the request is
signed with, so a click in that gap starts a run the server then refuses. On
expo it is defensive: every account change there passes through a teardown that
unmounts the view.

What survives, and why: the **session** (staying signed in is the point — this
is the "start over" action, not the "leave" action), the **cached subscription
status** (entitlement is untouched), and **`localSettings`** (theme/layout
device overrides are this device's preferences, not "your data"; the synced
`settings/general.enc` they override _is_ wiped). This is `clearData` minus the
identity/device stores — the two teardowns are cross-referenced in
`clear-data.ts` and must stay aligned when stores are added.

### delete account — the full teardown

`POST /v1/auth/delete-account` (contract beside the other auth endpoints,
service in `services/account.ts` `deleteAccount`). "Deactivate" — a flag that
keeps the ciphertext — was considered and rejected: with no email and nothing of
the library readable server-side, an unused account is already inert (no public
surface, only the key-holder can ever touch the data), so a flag stops nothing,
while retaining data the user asked to remove violates the privacy stance. And
"no undo but data kept" is the worst combination of properties — can't come
back, _and_ not deleted. So the account action is deletion, done properly.

**Double guard.** The route requires the bearer token (names the account) AND
a fresh signed proof (`action: 'delete-account'`, the same
`verifyAuthProof` machinery as sign-in) — the user re-enters their password,
the client unwraps the DEK and signs. A stolen session token alone can never
erase an account. The service then binds the proof to the session (the signed
username must resolve to the authed userId — a valid proof for account A on a
session for account B dies) and runs the same load-bearing check as sign-in:
the proof's `publicKey` must equal the **stored** credential.

**Subscription gate.** 409 `subscription_active` while the subscription would
keep billing — `status === 'grace'` (dunning: the provider is still retrying
charges) or `willRenew`. Cancellation happens in the Paddle portal
(`POST /v1/iap/portal`), never inside the deletion call — deletion must not
mutate provider state. A **canceled-but-still-entitled** subscription passes:
billing already ended, and holding deletion hostage until the paid period runs
out would be hostile; the remaining time is forfeited (the UI says so). The
client pre-warns from the cached entitlements read, but the server check is
the gate.

**Teardown order — every crash window is finishable by retrying with the
still-live session** (which is why sessions go last), and every step is
idempotent:

1. **Wipe the data plane** — the same `deleteAllUserData` as delete-all.
2. **Tombstone the username** — `deleted_at` set on the directory row, row
   kept. From here sign-in is already refused (opaquely — a tombstone answers
   exactly like a name that never existed on the pre-auth door fetch and
   sign-in).
3. **Delete doors + user row** — one atomic shard `batch`, the same
   all-or-nothing pairing create-account writes them with. Doors gone = the
   **cryptographic kill**: no wrapped DEK survives, so any stray ciphertext is
   permanently unreadable even if a copy escaped deletion.
4. **Revoke every session** (`revokeAllSessions`): each row keeps a revocation
   marker rather than being deleted, so every device that comes back is told
   `session_revoked` and erases the account's copy ([sessions.md](./sessions.md)).

The tombstone lands _before_ the shard delete so the retry path can always
recognize an in-progress deletion: tombstoned entry + missing user row =
resumed teardown (finish the remaining steps; there is no credential left for
the publicKey check to protect); missing user row _without_ a tombstone stays
what it always was — a server-side inconsistency to log and answer opaquely.

**What's deliberately kept:**

- **The username row (tombstoned).** The handle stays occupied forever so
  nobody can re-register it and be mistaken for the previous owner. This is
  the right _default_ because of the asymmetry: a release-after-cooldown
  policy can be added later, but a released name can never be re-occupied.
  ~70 bytes per deleted account, in the directory that outscales the shards
  ~20× anyway.
- **`purchases` rows.** Money-adjacent audit state — a provider id plus our
  random userId, no personal data. Late provider webhooks for a deleted
  account already log-and-drop in `applyPaddleEvent`.
- **The session rows, revoked.** Each keeps its marker for
  `SESSION_RETENTION` (a year) after the revocation, so a device that connects
  late still learns to erase its copy; the daily cron then purges it. The
  /delete-account and /privacy pages say so.

**The deleting client** (`web-react` `hooks/use-delete-account.ts` +
bracemark-web's Account section): door fetch → `unlockAccount` (the wrong-password
check is the GCM tag, exactly as at sign-in) → sign → POST →
`endSession({ username })`,
which runs the full `clearData` wipe and drops the local session (in the
three-step order [above](#the-sign-out-teardown--close-the-gate-then-wipe) — the
gate closes before the wipe, so nothing is mounted to watch the data vanish);
AuthGuard
sends the user out to the marketing site's landing page (the same destination as
a deliberate sign-out — there is no signed-out page on `app.bracemark.com` worth
landing on; from an installed PWA it stays on `/sign-in` instead, see
[architecture.md](./architecture.md) — _apps_). Typed errors keep the form honest:
`InvalidCredentialsError` → "Incorrect password", `SubscriptionActiveError` →
a pointer at the Subscription section.

### main-thread cost — measured, not assumed

Import and export run on web's **main thread**, and that is a decision to
re-check with numbers, not a default to defend or overturn by feel. Much of
either flow is waiting, which a Web Worker doesn't speed up: the opening sync
refresh is network, zip.js compresses in its own workers, and the import's write
loop yields between `WRITE_CHUNK`s. The flows are also tied to main-thread state
a worker would have to reach by message: the `db` instance, the sync engine's
keys and queue, the interactive `onQuotaPrompt`, and export's
`showSaveFilePicker`, which needs the click's user activation.

So the question is never "is it fast". It is **how long does the longest single
task hold the page**: a thirty-second import whose progress line keeps moving
is fine, and a three-second freeze is not. Measure it with `npm run
measure:data` ([e2e.md](./e2e.md), _measuring the data path_), which reports
the longest task per leg at a CPU slowdown. Then find what **owns** that task
before choosing a fix (`--trace`, then the DevTools Bottom-Up tab over the long
task), and decide by the band:

| longest task, slowed, at the size you care about | what to do                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| under ~200 ms                                    | leave it; record the reading here                                                  |
| ~200 ms – 1 s                                    | split the owning loop into chunks with a yield between them                        |
| over ~1 s                                        | a worker for that step **if the step is pure** (no store, no session); else chunks |

A worker only helps a step that can run without the store. The one pure step
the flows have is the file → `ImportedBundle` parse (`parseImportText` and the
parsers under it, DOM-free on purpose), and it doesn't need one: every parser
is a generator that yields every `PARSE_CHUNK` records, and both orchestrators
await `parseImportTextInChunks`, so the parse pauses like the loops do. See
_readings — expo_, **2026-09-26, the parse**. Store reads, per-record validation and the
projection all touch Dexie or run between Dexie calls, so moving them means
moving the store, which is the architecture change the paragraph above argues
against. Keep the store writes, the sync kick and the quota prompt on the main
thread whatever the reading says. The bands follow INP's (good ≤ 200 ms, poor >
500 ms), widened at the top because an import is a rare, user-started action with
a progress line, not a keystroke.

**Paid plans have no link cap** (`maxLinks: null`), so no size is the worst
case. Pick the sizes to measure and record them with the reading, along with
the date, the machine, the Chrome version, the CPU factor, and whether it was
the production export (the default) or `--dev`.

#### readings

**2026-09-25, before chunking** — Apple M1, 16 GB, macOS 26.5.2, Chrome 153.0.8010.53, CPU 4×
slower, the production export. The run's calibration read the same fixed work
at 127–130 ms at 1× and 519–539 ms at 4×. Checkout `353fa04` plus the
uncommitted change that added the tool. Longest main-thread task per leg:

| leg                   | 1,000 links | 10,000 links | 50,000 links |
| --------------------- | ----------- | ------------ | ------------ |
| import HTML bookmarks | < 50 ms     | 146 ms       | 659 ms       |
| import backup         | 54 ms       | 432 ms       | 2,210 ms     |
| export HTML bookmarks | < 50 ms     | 314 ms       | 1,808 ms     |
| export CSV            | < 50 ms     | 303 ms       | 1,753 ms     |
| export plain text     | < 50 ms     | 344 ms       | 1,661 ms     |
| export backup         | < 50 ms     | 302 ms       | 1,562 ms     |

Each long task grows with the library, and none of it is the parser or a
serializer. A `--dev --trace` run at 10,000 links (same bands: 174–478 ms)
put the time in these places. At 50,000 links, the production run's
long-animation-frame entries show the same entry points.

- **HTML import:** `projectImportedLinks`, which parses every address
  (`hostFromText`) and mints an id per new entity (`randomUUID`), then the
  dedupe's `canonicalUrlKey` per row. `parseImportText` never reached 50 ms.
- **Backup import:** in `importBracemarkBackup`, the `classifyBundleLine` loop
  (a JSON parse and a schema check per line) and the skip-existing
  `db.items.bulkGet` over every path, which issues and collects one
  IndexedDB `get` per entity in a single pass.
- **Every export:** `gatherLinks`, where `parseBlob` decodes and validates every
  link and then every extraction, fed by IndexedDB reads of the whole
  namespace. `GATHER_CHUNK` splits the links loop but never awaits, so the
  chunks still run as one task. `toNetscapeHtml` and `toRaindropCsv` don't
  appear.

**Decision:** no Web Worker for import or export. The owners fail the table's
purity test: they are store reads and per-record work between them. The
remedy is to yield inside the owning loops, which the second reading
measures.

**2026-09-25, after chunking** — same machine, Chrome, slowdown and sizes;
calibration 127–131 ms at 1×, 518–532 ms at 4×. What changed: the loops above
now await `yieldToMain` (web-react `lib/yield-to-main.ts`: `scheduler.yield()`,
else a `setTimeout(0)` task) between chunks.

- `gatherLinks` yields every `GATHER_CHUNK` (500) in both passes. The
  extraction `bulkGet` is sliced to match.
- The restore's classify pass and its skip-existing `bulkGet` go
  `YIELD_CHUNK` (1,000) at a time, as does the interop dedupe.
- The projection pauses every `PROJECT_CHUNK` (1,000) rows through
  `projectImportedLinksInChunks`. That shares one generator body with the
  synchronous `projectImportedLinks`, which expo and the specs still call, so
  the two can't drift.

| leg                   | 1,000 links | 10,000 links | 50,000 links |
| --------------------- | ----------- | ------------ | ------------ |
| import HTML bookmarks | < 50 ms     | 83 ms        | 424 ms       |
| import backup         | < 50 ms     | < 50 ms      | 167 ms       |
| export HTML bookmarks | < 50 ms     | 92 ms        | 371 ms       |
| export CSV            | < 50 ms     | 81 ms        | 378 ms       |
| export plain text     | < 50 ms     | 67 ms        | 290 ms       |
| export backup         | < 50 ms     | 66 ms        | 302 ms       |

Up to 10,000 links every leg is now in the first band. At 50,000 the backup
restore dropped from 2.2 s to 167 ms and the exports from 1.5–1.8 s to
0.3–0.4 s. Wall times barely moved (the 50,000-link restore went from 28 s to
31 s), which is the trade: the page keeps painting while the work takes as long
as it did.

What owns the four 50,000-link legs still in the 200 ms – 1 s band is no longer
a loop, so chunking can't reach it:

- **HTML import (424 ms):** `TextDecoder.decode` and `parseImportText` over
  the whole file, one synchronous call. This is the one pure step, and the
  table's worker row applies to it once it crosses ~1 s. That is roughly two
  and a half times this file, if it keeps scaling linearly. Until then it stays
  on the main thread. (Since split into chunks on both platforms, because
  expo crossed the line first: _readings — expo_, **2026-09-26, the parse**.
  Web not re-measured.)
- **HTML, CSV and text exports (290–378 ms):** the single `toArray()` in
  `gatherLinks` that reads the whole `links/` namespace in one IndexedDB
  request. The structured clone of every record lands in one task. The fix is
  to read in keyed pages rather than to yield.
- **Backup export (302 ms):** zip.js's main-thread side, handling
  `items.jsonl` passed as one string (`TextReader`). The fix is to hand it the
  lines in pieces.

Neither of the last two has been changed.

#### readings — expo

**2026-09-25** — the iPhone 17 simulator (iOS 26.5) on the same M1, measured
with `npm run measure:native` ([e2e.md](./e2e.md), _measuring the data path_).
The JS is a production bundle (`--no-dev --minify`, Hermes) on the development
client, against the local stack. Checkout `88721c3` plus uncommitted work.
The instrument is expo-react's stall probe (a 16 ms timer's lateness), not the
browser's `longtask`. Longest single JS-thread stall per leg:

| leg                   | 300 links | 1,000 links | 10,000 links |
| --------------------- | --------- | ----------- | ------------ |
| import HTML bookmarks | 1,177 ms  | 3,809 ms    | 63,946 ms    |
| import backup         | 1,963 ms  | 6,526 ms    | 80,439 ms    |
| export HTML bookmarks | 108 ms    | 357 ms      | 3,948 ms     |
| export CSV            | 114 ms    | 367 ms      | 3,797 ms     |
| export plain text     | 98 ms     | 355 ms      | 3,637 ms     |
| export backup         | 225 ms    | 648 ms      | 6,684 ms     |

**A simulator is not a phone, and here that makes these a lower bound.** The
simulator runs at the Mac's speed with no CPU throttle, so a mid-range phone
freezes for longer than this. The probe's calibration (1.5e7 iterations of a
fixed loop) read 771–782 ms on this Hermes. Web's calibration runs ten times
the iterations in 127–131 ms on V8, so Hermes ran that tight loop about 60×
slower. Real code narrows that gap, because a loop like this is where a JIT
helps most, but the calibration is the number to compare devices by.

**The run never yields, and that is the finding.** In every leg the one stall
is nearly the whole run: the 10,000-link HTML import took 64.4 s, and 63.9 s of
that was a single stall. The rest was the opening network refresh. So the
progress line never repaints and a tap is not answered until the run is over.
The stalls scale linearly (1.2 s → 3.8 s → 64 s for the HTML import), which
points at per-entity work, not a fixed cost.

**What owned it, profiled.** A Hermes CPU profile of the 1,000-link restore
and CSV export, taken through Metro's inspector ([e2e.md](./e2e.md), _finding
what owns a native stall_), and a Hermes CLI benchmark of the parser, found
five owners:

- **Nothing yielded.** The store calls are `async` in signature and
  synchronous inside (expo-sqlite through drizzle's sync driver), so every
  `await` between them resumed as a microtask in the same task. The
  `WRITE_CHUNK` loop, and every other loop, ran as one block. This is why the
  stall was the whole run.
- **drizzle's per-statement cost on the write edge.** `bulkWriteEntities`
  issued a select, an upsert, two junction deletes and a queue upsert per
  entity. It took 6.0 s of the restore's 6.4 s stall: about 3.5 s was drizzle
  building each statement in JS (`sqlToQuery` alone 1.9 s), and 1.1 s was
  `prepareSync` plus statement construction, because drizzle's expo driver
  prepares every one-shot query afresh. SQLite actually executing took 1.0 s.
- **Expo's `TextDecoder`.** Hermes has none, and the one Expo's winter runtime
  installs is a pure-JS polyfill. `bytesToUtf8` was 235 ms of the export's
  279 ms of `parseBlob`; the JSON parse and zod check were the rest.
- **The Netscape parser was quadratic on Hermes**, which the profile could not
  show at 1,000 links and the 10,000-link HTML import (31 s in one stall, in a
  run with the three fixes above) did. The Hermes CLI, timing the parser at
  1,000/2,000/4,000 links, read 336/1,247/4,601 ms. The owner was the token
  regex's lazy `[\s\S]*?` captures. On Hermes a lazy loop over a character class
  costs time proportional to the rest of the input on every match; `.*?` under
  the `s` flag matches the same characters and is linear (4,000 links: 3,553 ms
  against 3 ms), and V8 runs both alike.
- **`zipSync`** held the backup export for ~0.3 s per 1,000 links in one call.
  `unzipSync` on the restore was small.

**What changed.** Not `expo-sqlite`'s async API, last reading's structural
candidate: SQLite executing was 1.0 s of the write edge's 6.0 s, and moving it
off the thread would have left drizzle building every statement on it. The
batching below removes most of both.

- **The write edge is set-at-a-time.** item-store's `putItemsTx` sends one
  multi-row upsert per `rowsPerStatement(items)` records, pending-store's
  enqueue does the same (`enqueuePutsTx`), and `bulkWriteEntities` reads every
  base stamp in one `itemUpdatedAtsTx`. The `excluded.*` SET clause comes from
  the table's own columns (`upsertExcludedSet`, db.ts), so it keeps `put`'s
  full-replace semantics. A path repeated within one call ends as its last
  entry, as the per-entity loop left it. `mutations.spec.ts` pins that
  contract. The same restore's write time fell from 6.0 s to 1.2 s.
- **Real yields.** expo-react `lib/yield-to-main.ts` is a `setTimeout(0)`
  macrotask, awaited where web awaits its own (the dedupe, the classify pass,
  the skip-existing lookup, the projection through
  `projectImportedLinksInChunks`, the gather's two passes) and also before
  every write chunk and blob, where web's IndexedDB awaits yield by themselves.
- **`decodeUtf8`** (expo-react `lib/utf8.ts`) decodes stored blobs and import
  files with `TextDecoder`'s exact output: its spec holds it to Node's decoder,
  malformed input included. [expo-dependencies.md](./expo-dependencies.md),
  _runtime polyfills_, has why the global is left alone.
- **The Netscape token regex is `.*?` under `s`**, with a ⚠ note in
  `import/netscape.ts`. Nothing on web would notice a revert, so a
  `no-restricted-syntax` rule (`REGEX_SYNTAX` in `eslint.config.mjs`) now
  rejects `[\s\S]*?` and its other any-character spellings workspace-wide.
- **The backup zip streams.** fflate's synchronous streaming `Zip` deflates
  `items.jsonl` 256 KiB at a time with a yield between pieces, and each blob
  gets its own turn. zip.js reads the result (data descriptors and all), and
  `assertZipWritable` counts the 16-byte descriptor per entry.

**2026-09-26, after** — same simulator, Mac and production bundle, from `88721c3`
plus uncommitted work; calibration 767–776 ms. Longest single JS-thread stall
per leg:

| leg                   | 300 links | 1,000 links | 10,000 links |
| --------------------- | --------- | ----------- | ------------ |
| import HTML bookmarks | 130 ms    | 380 ms      | 1,243 ms     |
| import backup         | 389 ms    | 387 ms      | 648 ms       |
| export HTML bookmarks | < 50 ms   | 54 ms       | 329 ms       |
| export CSV            | < 50 ms   | 58 ms       | 376 ms       |
| export plain text     | < 50 ms   | < 50 ms     | 320 ms       |
| export backup         | 79 ms     | 163 ms      | 318 ms       |

The run now yields throughout. The 10,000-link restore went from one 80 s
stall to 102 stalls of at most 648 ms over a 34 s run, and the HTML import from
64 s to 18.7 s of wall time. The largest stall is at most 1.2 s at every size.
The restore's stalls barely grow with the file (387 → 648 ms), because each one
is a write chunk plus the live reads it triggers. Every commit re-runs the
mounted `useLiveRead`s (lists, tags, settings, the links screen under Settings)
and React re-renders, which before the fix happened only once, at the end.

What is still above the ~200 ms band, and why nothing more changed here:

- **HTML import at 10,000 links (1,243 ms):** the one `parseImportText` call
  over the whole file, now linear (~0.8 s at this size by the Hermes CLI), plus
  the decode around it. Since changed: **2026-09-26, the parse**, below.
- **Restore (389–648 ms):** a write chunk and its live-read re-run. Smaller
  chunks shrink the first half and multiply the second. What would help is
  suspending live reads for the duration of a bulk write. Since changed:
  **2026-09-26, the live-read hold**, below.
- **Exports at 10,000 links (318–376 ms):** not profiled at this size. By
  analogy with web's reading, the likely owner is the single `namespaceRows`
  read of the whole `links/` namespace, which materializes every row in one
  native call. The fix would be keyed pages.

Outside the windows the probe measures, the sync push that follows an import
has the same drizzle cost: `clearDrainedOps` and `stampItemUpdatedAts` issue a
statement per path, about 0.6 s per 1,000-path commit in the profile. It belongs
to the engine ([local-first-sync.md](./local-first-sync.md)). Since changed:
**2026-09-26, the live-read hold**, below.

**2026-09-26, the parse** — the Hermes CLI (the `hermes-engine` pod's build,
`hermesc -O`) on the same M1, timing the shared parsers directly at 10,000
records per format, with expo's `URL` (`whatwg-url-without-unicode`) installed
as the app has it. Not a `measure:native` run: the stall the probe would see now
is the largest of the decode, one parse chunk and the first dedupe chunk, and
that reading was taken later, in **2026-09-26, after the hold**.

The whole parse took 0.5–0.8 s in **every** format, not only HTML (HTML 768 ms,
CSV 711, LinkWarden 546, plain text 536, Brace 638). The token regex was not
the owner. Broken down for the HTML file:

| part of `parseNetscapeHtml`, 10,000 links    | Hermes | Node   |
| -------------------------------------------- | ------ | ------ |
| the whole parse                              | 743 ms | 110 ms |
| the token scan alone                         | 17 ms  | 1 ms   |
| `normalizeUrl` × 10,000 (its `new URL`)      | 511 ms | 71 ms  |
| `attr` building a `RegExp` per call × 50,000 | 154 ms | 10 ms  |

`new URL` is expo's pure-JS WHATWG parser, and every format's parser calls
`normalizeUrl` once per record, so that cost is the same in all five. Neither
option above was taken. A worklet runtime doesn't have expo's `URL`, so it
would need its own copy of the costliest part, and the file and its 10,000 rows
would be copied across runtimes on top of that. What changed:

- **`attr` compiles each attribute's regex once** (`import/netscape.ts`). The
  HTML parse went from 768 to 613 ms.
- **Every parser is a generator** yielding every `PARSE_CHUNK` (500) records:
  the Netscape token loop, the CSV character scan and its row loop, both
  plain-text modes, LinkWarden's links, and each of Brace's passes plus every
  image it decodes. `import/steps.ts` holds the two drivers, and the projection
  now uses them too. `parseImportText` drains the generator synchronously for
  the specs and the bookmark converter. `parseImportTextInChunks` pauses on
  `yieldToMain`, and both orchestrators call it, web included.

Longest single chunk after the change, same harness: HTML 26 ms, CSV 30,
plain text 27, LinkWarden 38, Brace 30. The parse still takes as long in total.
It just no longer holds the thread for all of it.

The bookmark converter on the marketing site is a **separate decision**, already
made. Its whole job is one synchronous call (up to `BOOKMARK_CONVERTER_MAX_ROWS`
rows, parsed, serialized and read back) with no store or session around it, so
its worker costs one small module and nothing else. What import measures does
not move it either way.

**2026-09-26, the live-read hold** — three changes made from the readings above.
All three come from what **2026-09-26, after** says owned the time, not from a
new profile. The reading that follows them is below.

- **Live reads are held for an import.** Every `useLiveRead` on screen names
  `items`, and a change event carries a table, not a path. So each restore write
  chunk re-ran lists, tags, settings, the quota count and the links screen, and
  re-rendered them. The restore wrote 1,000 links in 1.2 s at 200 links a chunk,
  about 240 ms a chunk, against stalls of 387–648 ms. That is why the re-run
  looked like the rest of each stall. `importAllData` now takes `holdLiveReads`
  (`data/live-read-invalidation.ts`) during the writes, released in a
  `finally`. Parsing and the quota decision remain outside the hold. While it
  is held, a change only marks a read as having missed one.
  The reads that missed one re-run on the next flush, which comes every
  `HELD_FLUSH_MS` (2 s) and on release. **The flush is periodic, not only on
  release**, because the yields keep the app usable during an import. A hold for
  the whole run (~34 s at 10,000 links) would hide an edit the user makes
  meanwhile for as long, and that looks like a lost edit. So an edit waits at most
  one interval. The first read and a `deps` change are never held, so a screen
  opened mid-import still loads.
- **The engine's two per-path statements are set-at-a-time.**
  `stampItemUpdatedAts` is one `UPDATE … FROM (VALUES …)` per 250 stamps, and
  `clearDrainedOps` one `DELETE … WHERE (username, path, write_id) IN (VALUES …)`
  per 166 ops, still a compare-and-delete evaluated inside the DELETE. Both
  build their rows with `valuesList` (db.ts), and SQLite's query plan searches
  the primary key for both. A 1,000-path commit goes from ~2,000 statements to 11.
- **A bulk sync cycle takes the same hold.** Every commit's restamp writes
  `items`, and a pull stores each record the moment it decrypts, so a large push
  or pull re-ran the reads on screen once per commit, or back to back for the
  whole pull. The engine holds live reads for a cycle's writes when it will write
  at least `BULK_CYCLE_PATHS` (100) paths, and for the initial sync's downloads.
  Ordinary cycles are not held. Each edit kicks a cycle, and a hold there would
  delay the edit's own re-render by up to a flush for nothing.

**2026-09-26, after the hold** — `npm run measure:native`, the same iPhone 17
simulator (iOS 26.5), Mac and production bundle as **2026-09-26, after**, from
`2f27d0c` plus the uncommitted changes above; calibration 768–781 ms. It is
also the first `measure:native` reading of **2026-09-26, the parse**. Longest
single JS-thread stall per leg:

| leg                   | 300 links | 1,000 links | 10,000 links |
| --------------------- | --------- | ----------- | ------------ |
| import HTML bookmarks | 112 ms    | 294 ms      | 323 ms       |
| import backup         | 124 ms    | 130 ms      | 647 ms       |
| export HTML bookmarks | < 50 ms   | 57 ms       | 310 ms       |
| export CSV            | < 50 ms   | 69 ms       | 387 ms       |
| export plain text     | < 50 ms   | 62 ms       | 346 ms       |
| export backup         | 81 ms     | 131 ms      | 336 ms       |

- **Restore at 300 and 1,000 links: 389 → 124 ms and 387 → 130 ms**, into the
  first band. There the hold removed what it was meant to: the re-run that
  landed on each write chunk.
- **Restore at 10,000 links: 648 → 647 ms, with 102 stalls both times.** The
  wall time fell from 34 s to 21.1 s, but the longest stall did not move. What
  owns it is in **2026-09-26, the restore profiled**, below. It is not the
  reads.
- **HTML import at 10,000 links: 1,243 → 323 ms**, and 18.7 → 14.4 s of wall
  time. This is the chunked parse and the hold together; the two aren't
  separated here.
- **The exports did not change** (every difference is within a run's noise).
  They still carry the owners **2026-09-26, after** names.

The sync changes are outside this reading: the probe windows import and export
only. Each restore's push did complete through the new statements before its
exports ran.

**2026-09-26, the restore profiled** — a Hermes CPU profile of one 10,000-link
restore, taken as _finding what owns a native stall_ in [e2e.md](./e2e.md)
describes: the same simulator, an unminified `--no-dev` bundle, the profiler on
the `React Native` target from after the cold launch to the end of the restore.
The probe read the same run as 679 ms longest and 102 stalls, so the profiler
did not change its shape. The samples come every ~12.5 ms, and a profile has no
task boundaries, so "busy stretch" below means consecutive non-idle samples:
several tasks can share one.

- **The live reads are cheap.** 16 flushes, 9–39 ms of reading each.
  `readNamespace` is the largest (166 ms across all 16). The guess in **after the
  hold** was wrong.
- **Every write chunk costs ~127 ms**, flat across the run (101 calls, 110–156
  ms), and never grows with the library. Across the chunks: drizzle building
  and preparing statements ~3.9 s, SQLite executing (`runSync`) ~4.2 s, the
  projection (`toItemRecord`, its `new URL` included) ~2.5 s. Between flushes a
  chunk is followed only by one ~20 ms commit (the progress line).
- **A flush sets off React work next to a write chunk.** Every busy stretch of
  500 ms or more that holds a flush is one write chunk plus 250–400 ms of React
  work. (This read, at the time, as the owner of the longest stall. It is not:
  see **2026-09-26, the pause**, below.) Reconciling came to 1.6 s over those stretches and
  committing to 359 ms, most of the commit in Fabric's `completeRoot`. The
  components that render are the **links screen** (`LinkRow`, FlashList's
  `ViewHolderCollection`, `LinkRowMenu`, `LinkPreviewImage`) and the
  **sidebar** (`Sidebar`, `NavItem`). Both stay mounted under Settings, because
  Settings is pushed onto the same stack (`app/(app)/_layout.tsx`) and nothing
  freezes a hidden screen. They re-render for data nobody can see. **Each flush
  also commits several times**: every `useLiveRead` re-runs from its own
  `setTimeout`, so each hook's result is a render and a commit of its own.
- **Why 1,000 links didn't show it:** that restore takes 2.2 s, so no periodic
  flush lands inside the window. Its 130 ms is one write chunk alone.

Where the fix belongs, in order of what it removes:

1. **Don't render hidden screens.** Made in **2026-09-26, the pause**, below.
   That section also explains why it is a pause and not native-stack's
   `freezeOnBlur`.
2. **One commit per flush.** Not made. Run the flushed reads from one timer and apply
   their results in one batch, not one `setTimeout` per hook.
3. **A smaller write chunk** (`WRITE_CHUNK` 200 → 100) would halve the ~127 ms
   floor. Not made. Only worth it once nothing longer than the chunk is left.

**2026-09-26, the pause** — the hidden links screen's live reads now pause while
Settings covers it, and the same `measure:native` run was taken again (same
simulator, Mac and bundle; `2f27d0c` plus the uncommitted changes; calibration
767–778 ms).

- **Not `freezeOnBlur`.** On Fabric, native-stack never freezes the screen
  directly below the focused one (`!isBelowFocused` in its
  `NativeStackView.native.tsx`), because a back-swipe reveals that screen and
  its animated values must stay live. Settings is one route in the `(app)` stack,
  so the links screen is always that screen and the option would do nothing. A
  freeze of our own would hide the frozen subtree (react-freeze suspends it),
  which a back-swipe reveals before it could lift.
- **What was made instead:** `LiveReadPause` (expo-react
  `contexts/live-read-pause.tsx`). Under a paused one, `useLiveRead` only notes a
  change, like the hold, and catches up when the pause lifts, even mid-hold. The
  links layout pauses from when the route has **disappeared**
  (`transitionEnd`, `closing`) to when it starts to **reappear**
  (`transitionStart`, not `closing`), in `features/links/use-paused-while-covered.ts`.
  Keyed on the native disappear, so the link editor's iOS pageSheet, which leaves
  the links screen showing behind it, never pauses it. `DATA-IMPORT-NATIVE-001`
  (an import from Settings, then its link, list and tag on the links screen once
  Settings closes) passes on the iOS simulator.

| leg (10,000 links) | before the pause                  | after the pause                  |
| ------------------ | --------------------------------- | -------------------------------- |
| import backup      | 647 ms · 13.1 s blocking · 21.1 s | 653 ms · 9.4 s blocking · 17.5 s |
| import HTML        | 323 ms · 8.3 s blocking · 14.4 s  | 271 ms · 7.0 s blocking · 13.1 s |

(Longest stall · total blocking · wall time.) The pause took 3.7 s of blocking
and 3.6 s of wall time off the restore, which is the hidden screen's renders. It
did **not** move the longest stall, and the three readings of it (648, 647, 653
ms, before the hold, after it and after the pause) are too constant to be a
render. The profile above has the owner, in the one busy stretch before the
first write that it didn't break down: **`unzipSync` (~307 ms) then `decodeUtf8`
of `items.jsonl` (~270 ms) then the first slice of the classify pass**, with no
yield between them. `importZip` and `importBracemarkBackup` run all three in one
task, and the classify loop's first yield comes only after 1,000 lines. At 1,000
links that task is a tenth the size and hides under the ~130 ms write chunk.
The 300- and 1,000-link legs and every export read as before, within a run's
noise.

The fix is to yield between the three steps (about half the stall), and after
that to inflate and decode `items.jsonl` in pieces. Made in **2026-09-26, the
whole-file yields**, below; the streaming is not.

**2026-09-26, the whole-file yields** — `import-all-data.ts` now yields after
`unzipSync` and after each whole-file `decodeUtf8` (`WHOLE_FILE_STEPS` there),
so the inflate, the decode and the first slice of the classify or parse loop
each run as a task of their own. `measure:native --links 10000 --no-exports`,
same simulator, Mac and bundle, `2f27d0c` plus the uncommitted changes;
calibration 771–775 ms:

| leg (10,000 links) | before the yields                | after the yields                 |
| ------------------ | -------------------------------- | -------------------------------- |
| import backup      | 653 ms · 9.4 s blocking · 17.5 s | 322 ms · 9.5 s blocking · 17.7 s |
| import HTML        | 271 ms · 7.0 s blocking · 13.1 s | 272 ms · 7.1 s blocking · 13.3 s |

(Longest stall · total blocking · wall time.) The restore halved, as expected:
its longest task is now about the inflate alone (~307 ms in the profile), with
blocking and wall time unchanged. The HTML import didn't move, so its decode
was never its longest task; what is has not been profiled. What would take the
restore further is `unzipSync`: fflate's streaming `Unzip` would inflate the
archive a piece per turn, as the backup export already deflates it. Not made.

### deferred

- **Username release after a cooldown** — loosen the tombstone policy if
  reclaiming handles ever matters; the column (`deleted_at`) already carries
  the timestamp a policy would key on. Loosen-only: never re-tighten.
- **"Sign out everywhere"** — `revokeAllSessions` (`sessions.revokeByUserId`)
  already exists for the teardown; exposing it as a standalone Account action is
  a cheap, fully reversible security control (distinct from deletion, which is
  why it isn't bundled here).
- **Tombstone-teardown sweeper** — a crashed deletion whose session expired
  before a retry leaves a tombstoned name with shard rows still present (data
  already wiped; sign-in already refused). Harmless but untidy; sweep alongside
  the orphan-claim sweeper in the daily cron that now runs session cleanup
  (`worker.ts` `scheduled`, [sessions.md](./sessions.md)).

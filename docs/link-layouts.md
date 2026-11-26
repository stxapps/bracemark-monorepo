## link layouts

How the links page lays out a library — the **card**, **list** and **table**
layouts — the display options on each, and how those choices are stored and
synced. Virtualization and row-height estimates are
[client-queries.md](./client-queries.md); the settings file format and
last-writer-wins are [local-first-sync.md](./local-first-sync.md); the table's
plan gate is [iap.md](./iap.md); labels and focus are
[accessibility.md](./accessibility.md).

**⚠ Three rules here are silent when broken** — no lint, no type error, and
usually no failing test:

1. **Read leniently, write strictly** (_the settings model_). One strict field in
   `settingsLayoutSchema` and the day a newer client writes a value this build
   doesn't know, the whole file stops parsing — every option on every older
   client resets to its default.
2. **Heights stay measured** (_heights_). An option changes an ESTIMATE, never a
   budget, except on the table.
3. **A tag strip's height is known at its first render** (_heights_). A height
   that changes after the list measured the item makes the list jump.

### the layouts

- **list** — the default: one dense row per link, a 64×40 thumbnail, the title,
  the address line, the tag strip, and a date column on a wide enough pane.
- **card** — a grid of previews: a banner image, the address line, the title,
  the tags. The column count follows the pane width and the card size.
- **table** — one fixed-height row per link, one truncated line per cell, the
  columns the user picks. Plus and up (the `tableLayout` entitlement), web only,
  and only on a wide pane.

### the table

Plus and up (the `tableLayout` entitlement, [iap.md](./iap.md)), web only,
`links/_layouts/table-layout.tsx`. The title is always the first column and the
one that flexes; the other columns are the user's choice and order
(`TABLE_COLUMNS` in `layout-options.ts`: site, URL, list, tags, added, modified,
note, kept copy — default site, tags, modified), each with a fixed width and a
priority.

- **Wide only.** Below `TABLE_MIN_PANE_WIDTH` the list renders instead: a table
  that can't show its own defaults is a list with a header. The number is DERIVED
  (912 at a 16px root: the row's chrome 68, the title's 280 minimum, the three
  default columns each with its 12 gap, and 16 for a classic scrollbar) and scaled
  by the root font size like the columns. A hand-written 840 summed the columns
  alone, so from 840 to ~911 the table opened with Tags already behind "+1"; the
  shared spec now pins the defaults fitting at the minimum. That rule also
  covers the browser extension's popup and a phone. Expo never offers the table
  (`NATIVE_LINKS_LAYOUTS`) and renders a stored `table` as the list; iPad and
  Android tablets are later work.
- **Never sideways.** When the chosen columns don't fit beside the title's
  minimum, the lowest-priority ones drop (`fitTableColumns`) and the header's
  column-chooser button shows "+N" (a columns icon, "Choose columns", otherwise).
  The button is always there: one that existed only while columns were hidden
  vanished with its open popover the moment a change inside it made the rest
  fit, and focus fell to the page. A sideways scroll hides the title
  under a bar the user has to find, and a trackpad flick that drifts moves the
  page sideways.
- **The fallbacks** are one pure function, `_layouts/resolve-layout.ts`: no
  entitlement, or a narrow pane, renders the list — and nothing is written back,
  so after a downgrade the stored `table` and its columns stay, and an upgrade
  brings them straight back. The Table radio shows a Plus badge to a free
  account, and picking it opens the upgrade instead of writing it.
- **One fixed row height** (2.75rem, one line per cell) — the one budgeted
  surface ([client-queries.md](./client-queries.md), _estimated vs. measured row
  heights_). The column widths and the title's minimum are written at a 16px
  root and scaled by the root font size in force, in the fit and in the cells —
  in plain px, a 24px default font held "blog.exampl…" and kept columns the text
  no longer fit.
- **A date header sorts** — the same column again flips the order, the other
  date column switches the field — and writes the sort on whichever pack source
  is active, the same value Settings → Appearance and View options write. The
  arrow and `aria-sort` read the order IN FORCE — the query's, which a hand-typed
  `?sort=`/`?order=` overrides and which coerces a newer client's value — never
  the setting's raw string, or they describe an order the rows are not in. (Under
  such a URL a header click still writes the setting, and the URL keeps winning.)
  Sorting
  by title or host needs new indexes and read-layer work, and is later.
- **The column chooser** (`components/table-columns-chooser.tsx`) is one component
  in three places: under the Table radio, in View options, and behind the
  header's "+N". Show/hide per column, reorder by drag (the Lists and Tags
  editors' dnd-kit setup) or by Move up / Move down for the keyboard and screen
  readers. A column a newer client wrote is kept, after the known ones. Behind
  "+N" the chooser marks the chosen columns the window can't fit "Doesn't fit"
  (still checked — the choice stands and comes back on a wider window), or the
  "+N" opens a list where every row looks shown and nothing says which N.
- **Semantics** on the virtualized divs: `role="table"`, `row`, `columnheader`
  and `cell`, `aria-rowcount` and per-row `aria-rowindex` (the header is row 1),
  `aria-sort` on the active date header. The table is a box just INSIDE the
  scroller, so Show more can follow it in the scroll without being a stray child
  of the table (which may own only row groups and rows). In bulk edit the header
  row gains a "Select" header over the checkbox cells — one cell short, it shifted
  every header a column right for a screen reader. Checking or unchecking a
  column in the chooser moves it between its two lists, so the chooser puts
  focus back on that column's checkbox.

### the two places to edit

- **Settings → Appearance** — Theme, then Link layout with the selected layout's
  options (one Sync/Device switch for the layout, its options and the sort), then
  Link sort. It is where the switch lives.
- **View options** — the same controls in place, on whichever source is active,
  with a line saying where that is saved and a link to Appearance. On web a
  popover (`_components/view-options-popover.tsx`) from its own topbar icon at
  `md` and up, and from a ⋯ menu item below `md` — a fifth icon there squeezed
  the view's title to "My …" at 320px. It is anchored to the bar's action group,
  so it opens in one place either way, and from the menu it opens in the menu's
  `onCloseAutoFocus`, once the menu has fully closed (opened sooner, the closing
  menu's focus read as a focus-outside and shut it). When the table is chosen
  and the account has it but the pane is too narrow, it says so in a status line
  (`tableTooNarrow`, reported by the main pane into the view-state provider) —
  otherwise picking Table on a narrow window looks like it did nothing. A missing
  entitlement gets no such line: the Plus badge and the upgrade cover that. On expo a sheet from the
  header's ⋯ menu (`features/links/view-options.tsx`) — a phone header has no
  room for a fourth target either. Both share their controls with
  Appearance (`layout-options-controls.tsx` in each app).

### the options

Each layout keeps its OWN values (`card`, `list`, `table` in the file), and the
UI shows only the selected layout's. Options with the same name share one code
path and one registry entry.

| option      | card                        | list      | default               |
| ----------- | --------------------------- | --------- | --------------------- |
| title lines | 1 / 2 / 3                   | 1 / 2 / 3 | 2                     |
| tag lines   | 1 / 2 / 3                   | 1 / 2 / 3 | 1                     |
| card size   | small / medium / large      | —         | medium                |
| image       | off / short / medium / tall | on / off  | card: tall · list: on |
| fields      | the field registry, below   | the same  | below                 |

- **Title lines and tag lines are CAPS, not reservations.** A short title, or one
  or two short tags, look the same at every value; spacing, font size and weight
  never change with them. Tags past the cap go behind "+N" on the last line.
- **Card size is a size, not a column count.** Each device turns it into its own
  column count from its own width, through one table both apps read
  (`CARD_SIZE_WIDTHS`): the narrowest a card may get before the grid drops a
  column, and the widest it is drawn. small 160 / 240 — two columns on a phone
  held upright, the size's point there, at the cost of a host that truncates
  sooner; medium 300 / 420, every card before the option; large 400 / 600 — one
  column on a phone, big cards on a desktop.
- **The card image is one choice**, stored as the `image` field plus
  `imageHeight` so turning the image back on brings back the last height. The
  card keeps its width; only the banner, and so the card, gets shorter. Each
  height is a fixed ratio of the card's width (`CARD_IMAGE_ASPECTS`): `tall` is
  the 12:7 every card had before the option, `medium` 2:1 (most preview images
  are about 1.91:1, so it crops almost nothing), `short` 3:1 (crops top and
  bottom).

**The defaults reproduce the look from before the options existed, exactly** —
`DEFAULT_LAYOUT_OPTIONS`. A user who never opens them sees no change, and an
absent file renders as the app always did.

**Rejected knobs**, so they aren't re-proposed without the reason:

- **A list image size or a list row size.** The thumbnail is sized to the
  two-line text block beside it (title 20 + 2 + host 20); a bigger one is taller
  than a one-line row, so either rows grow or the thumbnail stops lining up.
  Bigger images, still dense, is what card size small is for.
- **Density.** The root font size on web and the text size on expo already cover
  most of it. Only if people ask.
- **A two-column list.** Its reading order is unclear, and so are its keyboard
  and screen-reader orders. The table covers the need on wide screens.

### the field registry

`LINK_FIELDS` (`packages/shared/src/sync/layout-options.ts`): one entry per piece
of information a card or a list row can show or hide.

| info           | card                                          | list               | table                              | default                       |
| -------------- | --------------------------------------------- | ------------------ | ---------------------------------- | ----------------------------- |
| title          | always                                        | always             | always (the column that flexes)    | shown                         |
| image          | off / short / medium / tall                   | toggle             | a thumbnail column (later)         | card: tall · list: on         |
| address        | `host` / `url` / `none`                       | the same           | separate `host` and `url` columns  | `host`                        |
| list name      | toggle                                        | toggle             | column                             | off                           |
| tags           | toggle + tag lines                            | toggle + tag lines | column (one line, "+N")            | on                            |
| date           | `sorted` / `createdAt` / `updatedAt` / `none` | the same           | separate added and updated columns | card: `none` · list: `sorted` |
| pin icon       | always                                        | always             | always                             | shown                         |
| note icon      | toggle                                        | toggle             | column or badge                    | on                            |
| kept-copy icon | toggle                                        | toggle             | column                             | off                           |

- **The title always shows.** A link with no title shows its URL as the title.
- **`address` is one value, not two toggles.** The host and the URL are the same
  line — the favicon, then one of them, cut off at one line — and two toggles
  would allow "both", which a card or a row has no room for.
- **`date` is one value on card and list.** A row has room for one date, and its
  dates read in order down the list only when the date shown is the sort field
  (`sorted`). The table shows both dates as columns.
- **The list name** is hidden on a link whose list is the one being viewed, where
  it says nothing. Links in locked lists are already out of every view while
  locked, so no list name can leak. It is TEXT, not a button: on web a row's
  address line sits inside the row's link anchor, where a button may not nest,
  and the sidebar is already the way to the list. Expo could nest a Pressable,
  but both apps keep one behaviour. On a list row it shares the address line,
  capped at half of it; on a CARD it has a line of its own under the title,
  because half a small card's line left the address "r…".
- **The pin icon always shows**: pinned links sit at the top whatever the sort,
  and without the icon an old link at the top reads as a bug.
- **The note icon is a toggle**: it is the only place a note's text shows (on
  hover), so it is information, not just state.
- **Unknown field ids** (a newer client's) are skipped when rendering and KEPT
  when writing.

### the settings model

The **pack** is the links layout, its sort, and every layout's options. One
Sync/Device switch — the device-local `linksLayoutSource` — covers the whole
pack, so a table's header-click sort on Device stays on that device. Theme keeps
its own switch.

- **Sync** → `settings/layout.enc` (`settingsLayoutSchema`,
  `packages/shared/src/sync/entities.ts`).
- **Device** → the off-sync `localSettings` row (web-react `db.ts`
  `LocalSettingsRecord`; expo-react `db.ts` `LocalSettingsValue`, one JSON
  column, so a new field needs no migration): `linksLayout`, `sortOn`,
  `sortOrder`, `layoutOptions`.
- **One sort for all layouts**, not one per layout: switching from card to table
  must not reorder the library.

The resolution is shared — `syncLayoutPack` / `localLayoutPack` in
`packages/shared/src/sync/layout-options.ts` — and both apps' `useSettings` call
it. Its writers: `writeSettingsLayout` (both `data/mutations.ts`), and the
device-side `patchLocalLayoutOptions` (both `data/local-settings-store.ts`).
`useSettingMutations` has a setter per source (`setSync*` / `setLocal*`) and one
for whichever source is active (`setLinksLayout`, `setSort`,
`setLayoutOptions`) — the latter for surfaces that edit "what I'm looking at",
like the View options popover.

#### why a file of its own

Settings files sync last-writer-wins per file, and the shipped engine is
**local-wins and uploads the whole file** (local-first-sync.md, _conflict
policy_). A device that hasn't synced and tweaks one layout option would upload
its stale copy of every field in the file. In `general.enc`, that would silently
revert whatever changed elsewhere — `serverExtraction` and
`deviceExtractionMode: 'off'` included, which are privacy settings. The View
options popover makes layout the most frequent, most casual settings writer, so
it gets its own file.

**Theme stays in `general.enc`.** A file holds what is written together; it is
not named after a UI section, because a section can be regrouped for free and a
file rename needs a migration. Moving theme in with the layout would bring back
the overwrite this split exists to stop. If theme ever needs its own protection,
it gets its own `theme.enc`.

#### read leniently, write strictly

The rule `settingsGeneralSchema` follows, one level deeper. Every option is
optional and `.catch(undefined)`; every nested object is a `looseObject`, so no
value of any shape fails the parse and an option, field id or layout a newer
client wrote round-trips through an older one. Only the frame — the LWW
`createdAt`/`updatedAt` — is strict, so a non-settings object still fails
(`classifyBundleLine` relies on that). `linksLayout`, `sortOn` and `sortOrder`
are free strings and reach the UI intact. The read edge narrows the options with
`coerceLayoutOptions`; writers take the strict unions, and merge with
`mergeLayoutOptions`, which keeps everything a patch doesn't name.

#### the move

`linksLayout`, `sortOn` and `sortOrder` lived in `general.enc` before
`layout.enc` existed. Clients from before the move (expo builds and browser
extension builds stay in use for weeks) read them only there. So:

- **Read** each from `layout.enc`, falling back to `general.enc` per field when
  it is absent. That also covers a backup from before the move.
- **Write** `layout.enc`, and — for a transition — also write the same three
  fields to `general.enc` (`writeSettingsLayout`), so older clients still see the
  change. That second write carries the old overwrite risk for those fields, no
  worse than before. **Stop writing it** a few releases on, once older clients
  are gone.
- **Accepted while both versions are in use:** a change made on an OLD client
  goes only to `general.enc`, and new clients ignore it once `layout.enc` has a
  value. Cosmetic, and it ends when that device updates. Not merged by timestamp:
  a theme change bumps `general.enc`'s `updatedAt` too, so a merge would pick
  wrong.
- **Never drop or rename** the `general.enc` copies: an old device writes them
  back.

#### the Device source's missing values

The sort and the options joined the Device source after the layout, so a device
row from before has neither. Each falls back to the **synced** value — what that
device was showing — so nothing changes for a user already on Device. The first
device write of an option seeds from the synced options
(`patchLocalLayoutOptions`), so it changes one option rather than resetting the
rest. The layout keeps its old rule: an absent device layout is `list`.

Older clients treat sort as synced-only: they ignore a Device sort and keep
showing the synced one. Accepted; it ends when they update.

### heights

Both platforms MEASURE row heights (client-queries.md, _estimated vs. measured
row heights_), and the options change only the estimates for rows not yet
measured. The table is the one fixed-height surface: its cells are one line and
truncated.

A height that depends on the data is fine — titles have always taken one line or
two. What the list can't absorb is a height that changes AFTER it measured the
item. Today's one-line tag strip is safe because one line is one line tall
whatever the width turns out to be. With more lines, the strip must know its
width at its first render, or it grows after measurement and the list jumps.

**How each platform meets it:**

- **Web measures before paint.** `LinkTagChips` lays a hidden copy of every chip
  out at the row's width in a layout effect and keeps the chips that fit
  `tagLines`, so the strip's height is final before the virtualizer measures the
  row.
- **Expo estimates, at a width it knows at first render.** RN has no synchronous
  pre-paint measure, so the strip packs its chips into lines with the shared
  `fitChips` arithmetic and draws each line as its own single-line row — a wrong
  estimate truncates a chip instead of wrapping it, so the height is exactly the
  fit's. The width comes from, in order: the strip's own `onLayout` (a recycled
  cell keeps it), the list's shared width (`TagStripWidth` — the first strip to
  lay out stores it; for the list layout `main.tsx` starts it at an estimate from
  the pane), or the card's own exact width.
- **Measured** with a temporary probe on the iPhone 17 Pro and iPad (A16)
  simulators, `plus-worst`, tag lines 3: no strip changed its line count after its
  first render — fast scrolling both ways in both layouts, and a cold launch.
  Before the list's starting estimate, 2 of the first 4 rows did at a cold
  launch.
- **Wide characters count double.** The fit estimates a label's width from its
  length, and an emoji or an East Asian wide character is about two Latin
  advances (`advanceUnits`); counted as one, `a`, `⭐`, `読む` and `مهم` were
  packed onto one small-card line and shrank to "..".
- **The Android runs** (Pixel 8 and tablet AVDs, the same probe): no reflow in
  either layout, at a cold launch or scrolling.
- **At the largest text size** (iPhone 17 Pro at the OS maximum, so the app's 1.3
  cap; Pixel 8 at 1.3): rows, small cards, the View options sheet and the card's
  list-name line all hold. A text-size change made while the app is open leaves
  measured cells as they were until a relaunch — general expo behaviour, not this
  layout's.
- **The fallback**, if a device ever shows a jump: `EXPO_TAG_LINES_SUPPORTED`
  (`apps/bracemark-expo/src/lib/tag-lines.ts`) set to `false` keeps every expo
  strip at one line and hides the option there. The stored value is kept, so web
  still uses it.

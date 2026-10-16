## data limits — what is bounded, where, and why only there

Which values the app bounds — the depth of a list or tag tree, the length of a
name, the tags on one link — and, the half that matters more, **at which edge**
each bound lives. The per-edge mechanics are in the docs each edge already has
([data-lifecycle.md](./data-lifecycle.md) for import, restore and export,
[editors.md](./editors.md) for the editors, [local-first-sync.md](./local-first-sync.md)
for sync); this is the one place that says how they fit together.

### the rule: bound the doors that make data, never the ones that carry it

A limit belongs where data is **made** — an editor gesture, an interop import, a
backup restore — and nowhere that data is only **carried or read**: sync, the
store, the screens, an export. The carrying edges take whatever is stored, and
bound only what they _produce_ (how many guide lines a row draws, how deep an
exported file nests), never what they _accept_.

Two things force that split, and neither is a preference:

- **Sync can't hold a limit.** Two devices can each make a legal move that
  together go past it — A moves a list under B while B's device moves B's
  chain deeper — and neither write is wrong on its own. A sync that refused or
  trimmed a record past the limit would leave two devices with different
  libraries, which is the one outcome the sync plane exists to prevent.
- **A limit added later meets data stored before it.** The editors put no bound
  on depth until 2026-10-16, so a library can hold a 150-level chain today, and
  nothing about adding the rule makes that chain go away. A reader that refused
  it would hide data the user has; one that crashed on it (the stack overflow in
  [data-lifecycle.md](./data-lifecycle.md), _nothing that reads the list tree
  recurses_) took the app down on every launch.

#### tripwire: no new `.max()` in a schema that parses stored bytes

A schema cap is a reader cap too. `linkSchema`, `listSchema` and `tagSchema`
parse persisted bytes — on every read, on every device — so a value past a
`.max()` drops the record from every view, and nothing reports it: no type
error, no failing test (the fixtures are short), no symptom until a user's long
list name makes the list and its place in the tree vanish, its links falling
back to My List. The two text caps in the schemas (`LINK_TITLE_MAX`,
`LINK_NOTE_MAX`) were there from the first write, so no stored value can be past
them. Every cap added since lives at the writers only — the editors, the
mutation hooks, an import — and that is where a new one goes.

### what is bounded

| value                 | limit                               | made by: editors                                 | made by: interop import | made by: backup restore | carried: sync, store, screens, exports |
| --------------------- | ----------------------------------- | ------------------------------------------------ | ----------------------- | ----------------------- | -------------------------------------- |
| list / tag tree depth | `TREE_MAX_DEPTH` 100 levels         | a move past it is refused                        | placed at it, counted   | placed at it, counted   | accepted; exports place it, see below  |
| link title            | `LINK_TITLE_MAX` 300                | field `maxLength`                                | cut (`cleanTitle`)      | schema (line refused)   | schema                                 |
| link note             | `LINK_NOTE_MAX` 500                 | field `maxLength`                                | cut                     | schema (line refused)   | schema                                 |
| list / tag name       | `LIST_NAME_MAX`, `TAG_NAME_MAX` 200 | create field `maxLength`; the mutation hooks cut | cut, matched as cut     | as written              | accepted                               |
| tags on one link      | `LINK_TAGS_MAX` 100                 | not gated                                        | the row's first 100     | as written              | accepted                               |
| url                   | none                                | —                                                | —                       | —                       | —                                      |
| links                 | the plan's `maxLinks`               | the add form gives way to `LinkQuotaBanner`      | the over-cap prompt     | refused whole           | —                                      |
| bytes and files       | the plan's `maxBytes`, `maxFiles`   | server, at `files/sign`                          | server                  | server                  | server                                 |

**Counts: none per kind.** Every link, list, tag, pin and extraction is one
`.enc` file, so the server's `maxFiles` and `maxBytes` ([iap.md](./iap.md),
_enforcement_) already bound all of them — a per-kind count would bound nothing
those don't, and would add a limit sync then has to carry. `maxLinks` is the one
count, a plan lever rather than a safety bound, and it is client-side.

**The url is uncapped on purpose.** It is the link's identity: a cut url is a
different link. The byte quota is its only backstop (`entities.ts`).

**A list or tag name** is cut at 200 by every writer — `cleanName` in the
mutation hooks (both platforms' `use-list-mutations` / `use-tag-mutations`),
which every create surface reaches (the settings tables, the pickers'
"create" rows, the share sheet), and the import resolvers — and the settings
tables' create row stops typing there. The schema does not carry it, so a name
stored before the cap stays whole; a **rename** leaves an unedited name alone
however long it is, and cuts only one the user changed. An import matches names
as cut, so two long folder names sharing their first 200 characters under one
parent become one list.

**Tags on one link** stop at 100 at import only — the file's first 100, and no
tag minted for a name past them. `tagIds` is inline in the link's `< ~2 KB`
metadata, and a file can name any number per row; no editor comes near 100 by
hand, so none is gated, and a bulk "add tag" onto a link already at 100 would
take it to 101 without complaint. What that costs is one round trip: an interop
export writes every tag a link has (`bundle.ts`), and importing that file back
keeps the first 100 and does not count the rest. A backup restore takes them
as written, so it loses none.

### the depth limit, edge by edge

`TREE_MAX_DEPTH` (100, `sync/tree.ts`) is the one constant. It replaced two that
held the same number (`IMPORT_MAX_FOLDER_DEPTH`, `EXPORT_MAX_FOLDER_DEPTH`).
100 is far past any real library — browsers and their users stop within a dozen
levels — which is the point: the bound should never be met by a real one, and
exists because the file, the other device or a long-lived library can choose
depth, and several readers still pay per level.

**One shape everywhere a tree is placed at the limit.** A list deeper than 100
goes AT level 100: beside its level-99 ancestor's other children, under its own
name and holding its own links, and its own descendants follow it there. So no
link lands in a list that isn't its own, and only the nesting below the limit
is lost. The interop exports write that shape, an interop import builds it and
a restore stores it, so a deep library exported and imported again comes back as
the same lists. The alternative — cut each path at 100 names — merges every
deeper list into its level-100 ancestor, which moves links into a list that was
never theirs. What the shape does lose: two deep lists with one name under the
same level-99 ancestor end up as one list in an import (it finds by name), and
as two folders with one path in a CSV.

- **Editors — refused.** `deepestDepthFor(nodes, id)` (`sync/tree.ts`) is the
  deepest a list may be placed with its whole subtree still inside the limit.
  `forbiddenParentIds` adds every parent too deep for it, so the "Move to"
  picker on both platforms leaves those out; the set is closed downwards (a
  too-deep parent's children are deeper still), so the picker's
  drop-the-subtree rule removes nothing it would have offered. On a drag,
  `getMovePlan` (`sync/tree-dnd.ts`) works the limit out from the forest itself
  and returns no plan for a drop past it — the row eases home like any drop
  that changes nothing — and both sections pass the same number to
  `getProjection` as `maxDepth`, so the live indent never shows a depth the drop
  refuses. A subtree **already** past the limit may still move anywhere no
  deeper than it sits: lifting it is never refused. New lists are created at
  the top level only, and the tags table is flat, so a move is the only gesture
  that deepens a tree.
- **Interop import — placed at the limit.** It used to refuse the whole file.
  `capFolderPath` (`import/resolve.ts`) holds a path to the first 100 names
  plus the row's own folder; Netscape, CSV and LinkWarden paths are capped as
  they are parsed, so a long chain no longer costs a path copy per level per
  row. `ListResolver` files the row's own folder under the level-99 list and
  counts the lists it placed (`flattenedListCount` on `ProjectedImport` and
  `ImportOutcome`). A folder between level 100 and the row's own that holds no
  link of its own is not minted — the interop import only ever mints what a
  link is filed under. A system-list row's path is never resolved, so never
  counted.
- **Backup restore — placed at the limit.** It used to refuse the whole file,
  with a message telling the user to fix the account it came from — which could
  already be deleted, and was the user's own library either way.
  `flattenBackupTree` (`data/backup.ts`) runs after `firstLinePerPath` and
  before anything is looked up or written. It builds the file's list and tag
  trees with the read edge's own `buildTree` (so a `parentId` loop is cut where
  every device cuts it), with the system lists' defaults standing in for any
  the file leaves out, and moves the `parentId` of every line past the limit to
  its level-99 ancestor (`parentsPastMaxDepth`). Nothing else on the line
  changes. `ImportOutcome.flattenedListCount` / `flattenedTagCount` count the
  moved lines that were written. **The bound is per file, not per library**: a
  parent the file doesn't hold ends a chain, so a restore can hang a chain under
  a deep list the library already holds, and a list the library already holds
  keeps its stored parent whatever the file's line says.
- **Sync — nothing.** See _the rule_. A chain past the limit arrives, is stored
  and is shown.
- **Screens — bounded in what a row shows, never in the tree.**
  `TREE_ROW_MAX_LEVELS` (32) caps a picker row's path label and guide lines
  ([data-lifecycle.md](./data-lifecycle.md), _a row describes at most_); the
  sidebars render flat rows; and the lock provider reads the real forest, which
  [locks.md](./locks.md) requires. The web Lists table used to work out
  `forbiddenParentIds` for every row on every render — a forest walk per row,
  so the square of the list count on every drag frame — and now asks it only of
  the row whose menu is open.
- **Interop export — placed at the limit.** `foldersWithPaths` and the Netscape
  writer place a deeper list at level 100, so the file is one this app's import
  nests exactly as written; `ExportOutcome.flattenedListCount` says how many.
- **Backup export — written as it is, and said.** A backup is a copy of the
  library, so it keeps every `parentId`. The receipt counts what a restore
  would place at the limit (`pastMaxDepthListCount` / `pastMaxDepthTagCount`,
  asked of `flattenBackupTree` itself) and tells the user, while they still have
  the library to move those lists in. A backup that restores with its deep lists
  moved is better than one that doesn't restore, but a user who is told can
  keep the nesting.
- **The bookmark converter** ([data-lifecycle.md](./data-lifecycle.md), _the
  bookmark converter's limits_) is held to the same rule as the app — it reads
  the same parsers and writes the same serializers — and lists the folders it
  placed among the receipt's losses. It used to refuse both a deep bookmarks
  file and a deep backup.

**Why place rather than refuse, when the import used to refuse on purpose.** The
old reasoning was that shortening a path files links where the file never put
them. That is true of the cut-at-100-names shape, and not of the one above: every
link still lands in a list named for its own folder. Against it stood what
refusal cost — a file nobody could import without editing it by hand, and for a
backup, the one copy of a library refused at the moment it was needed. An import
changes the user's library, which is why it reports every list it placed; a
refusal changes nothing, but leaves them nothing either.

### what is still unbounded

- **A tree's depth in the store.** Sync, a restore under a deep library list,
  and a library from before the editor rule can all hold a chain past 100. Every
  reader copes (nothing recurses, rows are capped), and the editors let the user
  lift it.
- **The marketing site's converter's path copies** stay bounded by the limit
  rather than removed: it copies a path per folder, at most 101 names each.
- **Tags on one link by hand**, as above.

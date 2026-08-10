## editors & the list/tag taxonomy UI

How bracemark **edits a link** (create + full edit, across three surfaces on two
apps) and how the **list/tag taxonomy** those editors write into is displayed and
picked elsewhere. This is a cross-cutting reference: the editors share a small set
of pickers and a set of invariants, and the same pieces (or the same underlying
data) surface in places that aren't editors at all — the sidebar tree, the row
menu's "Move to". Change an editor without this map and you can silently break one
of those.

See [link-extraction.md](./link-extraction.md) for the _data_ side of what these
editors write — the override-wins model (`customTitle`/`customImageId` sitting
over the extracted fallbacks), the writer-split that keeps a background capture out
of `links/{id}.enc`, and where `resizeImage` fits as the client thumbnailing step;
[client-queries.md](./client-queries.md) for the `useLists`/`useTags`/`useLinks`
read edges every surface here renders over; and
[architecture.md](./architecture.md) for the `web-ui` → `web-react` layering (why
the shared pickers live in `web-ui` yet reach `web-react`'s data hooks, never the
reverse).

### the editing surfaces

Six surfaces edit a link's user-authored fields. They split into **create** (a
URL + list/tags/note, title/image back-filled later by extraction) and **full
edit** (every `links/{id}.enc` field, including the `customTitle`/`customImageId`
overrides). Create collects a strict subset of edit's fields.

| surface                    | file                                                            | kind      | fields                                             |
| -------------------------- | --------------------------------------------------------------- | --------- | -------------------------------------------------- |
| extension save editor      | `apps/bracemark-extension/entrypoints/popup/Editor.tsx`         | create    | list, tags, note (URL is the tab's, read-only)     |
| web quick-add popover      | `apps/bracemark-web/.../links/_components/link-add-popover.tsx` | create    | URL, then list/tags/note behind "Advanced"         |
| web edit dialog            | `apps/bracemark-web/.../links/_components/link-edit-dialog.tsx` | full edit | title, image, list, tags, note                     |
| bracemark-expo quick-add   | `apps/bracemark-expo/src/features/links/link-add-screen.tsx`    | create    | URL, then list/tags/note behind "Advanced"         |
| bracemark-expo edit screen | `apps/bracemark-expo/src/features/links/link-edit-screen.tsx`   | full edit | title, image, list, tags, note                     |
| bracemark-expo share sheet | `apps/bracemark-expo/src/features/share/share-screen.tsx`       | create    | list, tags (URL/title arrive in the share payload) |

**Every create surface gates on the plan's link cap, because nothing behind them
does.** Free's 200-link wall is enforced HERE and only here: `files/sign` keeps a
byte/object backstop and no longer counts links ([iap.md](./iap.md),
_enforcement_), so a save that gets past a create surface syncs and stays. All
four create surfaces therefore refuse at the cap. The three **in-process** ones
read `useLinkQuota` and render `LinkQuotaBanner` + an upgrade CTA **instead of**
the form — web quick-add, the browser extension's popup, bracemark-expo's add
screen (that hook's header is the canonical rationale; it counts
trash-inclusive, because Trash is a listId and the blob still exists). The
bracemark-expo **share sheet** is the fourth, off `isAtLinkCap`
([share-sheet.md](./share-sheet.md)). The full-edit surfaces need no gate — they
write no new `links/` path at all, so they cannot move the count. That is also
what keeps **Remove** working over the cap: trashing is
`update({ listId: TRASH_ID })`, a re-put of a path that already exists, and it is
the first half of the only route back under the limit. Import has its own check
([data-lifecycle.md](./data-lifecycle.md)). The **share sheet** is the one
exception, on iOS-process grounds rather than principle
([share-sheet.md](./share-sheet.md)). A new create surface inherits the rule.

The two bracemark-expo in-app editors are the web pair's behavioral twins (same
validation, same quota banner on create, same dirty close guard — swipe-down /
Android-back swallowed via `usePreventRemove`) presented phone-shaped: both
are **modal-presented expo-router screens** (`/add-link` pushed by the links
screen's FAB, `/edit-link` pushed by the row menu with a `linkId` + optional
`focus` param) — router screens, not RN `Modal`s, so keyboard-controller and
portalled dialogs work inside them (docs/safe-area.md — the presentation
decides the keyboard mechanism). Two structural consequences: the edit screen
needs **no hoisted `editing` view state** (web hoists its dialog because
virtualized rows repaint under it; a pushed screen isn't row-anchored and its
draft is a snapshot), and its custom-image flow is **uri/path-based end to
end** (expo-image-picker → `resizeImage` uri→uri → `saveCustomImage` →
`writeFile` path-to-path copy) — file bytes never enter the JS heap, the
platform's file-store doctrine. They can't render the web pickers (`web-ui` is
`platform:web`), so they share **in-app native cousins** in
`apps/bracemark-expo/src/components/links/` (`list-select.tsx` over the shared
`list-command.tsx` body — the same shell/body split as web, with dialogs
standing in for anchored popovers — plus `tags-field.tsx` /
`link-quota-banner.tsx`) wired to `@stxapps/expo-react`'s live hooks. Unlike
the share sheet's snapshot-fed pickers, these run in-process and therefore
follow the web rule: they create **immediately** (top-level, index 0,
case-insensitive reuse) — see "web pickers create IMMEDIATELY; the share sheet
DEFERS" below.

The share sheet is the RN member of the create family
([share-sheet.md](./share-sheet.md) is its own map — the two native shells, the
iOS snapshot/outbox, the upload). It can't render the web pickers (`web-ui` is
`platform:web`), so it carries **share-sized presentational cousins**
(`share-list-picker.tsx` / `share-tags-picker.tsx` — rows in, events out, fed
by a taxonomy snapshot rather than the live hooks) that uphold the same rules:
create is opt-in and inline, every create lands top-level at index 0, an exact
case-insensitive name match reuses instead of minting, and the pickers filter
only Trash (the locks/hide rule below applies there too). Change a picker
invariant here and the share sheet must follow.

Two more surfaces edit the taxonomy itself (not links), as inline row editors —
not modal forms, so the invariants below apply loosely (they hold no snapshot
draft; each keystroke commits or reverts in place):

- `apps/bracemark-web/.../settings/[section]/_lists/lists-section.tsx` — create /
  rename / reorder / **reparent** / delete lists. Nesting _is_ the UI here: drag
  with live depth projection, a "Move to" submenu, and collapse toggles.
- `apps/bracemark-web/.../settings/[section]/_tags/tags-section.tsx` — the tag
  counterpart **minus nesting**: create / rename / **reorder** (drag or up/down) /
  delete, over one flat ranked group.
- `apps/bracemark-expo/src/features/settings/{lists,tags}-section.tsx` — the same two
  tables on native, drag included. **The projection math is literally the same
  code**: `excludeActiveDescendants` / `getProjection` / `getMovePlan` live in
  `@stxapps/shared` (`sync/tree-dnd.ts`), and each platform keeps only a px
  calibration beside its section (`dnd-helpers.ts` — web 20px per indent at a
  half-indent threshold, expo 16px at three quarters, because a finger dragging
  vertically jitters horizontally and would reparent rows by accident at web's
  rounding). What differs is the _surface_, not the rules: dnd-kit's pointer
  sensor vs. a long-press on a grip handle driving gesture-handler + reanimated
  (`drag-sort.tsx`, with `scroll-host.tsx` handling the fact that native rows
  drag _inside_ a page ScrollView — scroll-delta compensation, edge auto-scroll,
  scroll locking). Both platforms keep the up/down + "Move to" buttons as the
  complete non-drag fallback, and both route a nesting drop through the
  `nestedLists` paywall rather than clamping the projection.

  **Lists nest, tags are deliberately flat — and that's a UI decision, not a
  schema one.** Tags carry the _same_ `parentId`/`rank` fields as lists
  (`entities.ts` — both are the same ranked-tree entity), so the store could nest
  them. The tags section chooses not to: a link belongs to exactly **one** list
  (a location → a hierarchy earns its keep) but has **many** tags (flat labels →
  a second hierarchy would only blur "where it lives" vs. "what it's about" and
  duplicate the list tree). So `tags-section` drops everything nesting brings —
  depth projection, the "Move to" reparent submenu, collapse toggles, and the
  system-entity guard (every tag is deletable; there are no system tags) — and
  reorders with a plain `arrayMove` over `useTags`'s top level, which _is_ the
  whole set precisely because nothing nests tags (`buildTree` also re-roots any
  dangling parent). The asymmetry lives only in these two sections + the pickers;
  if tag nesting is ever wanted, the schema, `buildTree`, and `useTagMutations`
  (`move` already takes a `parentId`) already support it — only this section and
  `tags-command` would change.

All link writes go through **one op** — `useLinkMutations` (`create` / `update` /
`saveCustomImage`) — and taxonomy writes through `useListMutations` /
`useTagMutations`. The editors never touch the sync layer; they fire intents and
the one-file-per-entity LWW model does the rest.

### the shared pickers (and their non-obvious consumers)

The list and tag inputs are **two picker pairs** in
`packages/web-ui/src/components/links/`. Each pair is a form-control shell over a
searchable command body; the body owns the tree/search rendering and is wired
straight to `web-react`'s live data hook:

| pair | shell                                            | body                               | data hook                       |
| ---- | ------------------------------------------------ | ---------------------------------- | ------------------------------- |
| list | `list-select.tsx` (`ListSelect`, a combobox)     | `list-command.tsx` (`ListCommand`) | `useLists` / `useListMutations` |
| tag  | `tags-field.tsx` (`TagsField`, a token combobox) | `tags-command.tsx` (`TagsCommand`) | `useTags` / `useTagMutations`   |

All three link editors render `ListSelect` + `TagsField`, so the pickers stay
identical across web quick-add, the extension, and the edit dialog. That's the
point of the pairing — one picker over one live tree, no drift.

**Both pickers can CREATE, and both creates are opt-in on the shell.**
`TagsField` always mints (a tag editor with no way to make a tag is barely an
editor); `ListSelect` mints only under **`allowCreate`**, which the three link
editors pass and the move-to menus below must not. The rows themselves are
`TagsCommand`'s always-on Create and `ListCommand`'s **`onCreate`**-gated one.

- **Why inline, rather than a "Manage lists" link out to Settings → Lists** (the
  shape the sidebar's `FooterLink` uses): the sidebar holds no draft, and every
  editor does. Navigating away destroys it — the quick-add popover would drop the
  very URL/note its `advancedDirty` guard exists to protect (invariant 3), and the
  extension popup would be killed outright by `tabs.create`, since a popup
  dismisses on focus loss uninterceptably. "Add a list" is a **sub-task of the
  save**; anything that ends the save to do it isn't an answer.
- **Every create lands in the same place: top-level, index 0.** `parentId: null`
  and the head of the root group — for **both** entities, on **every** surface: the
  settings `CreateRow`s, `ListSelect`'s Create row, `useTagMutations.findOrCreate`,
  and the share sheet's two pickers. One action, one landing spot, wherever it's
  invoked; there is no per-entity or per-surface variation to remember. Two halves
  to the rule, each load-bearing for a different reason:
  - **Top-level is what keeps the create cheap despite the lists/tags asymmetry.**
    `findOrCreate(name)` takes only a name because a tag **is** its name;
    `useListMutations.create(name, parentId, siblings, index)` needs a **position in
    a tree**. The editors decline to ask: nesting is non-destructive to defer
    (`move` is a one-field `{ parentId, rank }` write), and rebuilding the settings
    tree editor — drag, depth projection — inside a 320px popover would be absurd.
    Create now, reparent later, lose nothing.
  - **Index 0 puts the new row where the eye already is** — beside the `CreateRow`
    that minted it, at the top of the still-open picker. Against a hand-ranked
    group an append is no less arbitrary and merely invisible: a new tag landing
    below the fold of a long list reads as "did that even work?". The cost is that
    several tags typed in one editor session stack **newest-first** (a, b, c → c, b,
    a), since `findOrCreate` re-reads the store per call and holds no session state.
    That's accepted, not overlooked: the link's own `tagIds` preserves the typed
    order regardless (it's what renders the chips), so the reversal touches only the
    global picker order, where recency is the more useful key anyway. Buying typed
    order back would mean threading an anchor through a deliberately stateless hook.
- **The web pickers create IMMEDIATELY; the share sheet DEFERS to Add — that's a
  constraint, not a preference.** `ListSelect`/`TagsField` write the entity the
  moment a name is confirmed: they run in the app's process, so the create hits the
  store and the live `useLists`/`useTags` query renders the row/chip a beat later
  (the catch-up gap both shells already account for). The iOS share extension is a
  **separate process that must never open the app's sqlite**
  ([share-sheet.md](./share-sheet.md) — a shared-container lock invites the
  `0xdead10cc` kill), so it _cannot_ create immediately; it mints the id **and the
  rank** in the sheet and ships them on the draft to be created at Add.
  `share-screen` is platform-blind, so Android defers too even though, running
  in-process, it could write live. Don't "fix" either side to match the other:
  deferral is what forces the sheet's pending-entity state, its
  created-means-selected discard rule, and the idempotent drain + upload —
  machinery that only pays for itself where the process split leaves no choice.
  What must stay identical is the user-visible rule (top-level, index 0,
  case-insensitive reuse), and it does. **The accepted cost on web:** confirming a
  name and then cancelling the editor leaves the list/tag behind, since the write
  already happened. `findOrCreate` reuses it on a retype, and Settings →
  Lists/Tags is one delete away.
- **Two smaller consequences, both in `list-command`.** (1) The filter input is
  normally count-gated at `SEARCH_THRESHOLD` (scrolling beats a box), but
  `onCreate` **forces it on at any count** — it doubles as the Create row's name
  field, and without it a small account (i.e. most accounts) would have nothing to
  type into. (2) An exact case-insensitive name match **suppresses** the Create
  row. That's stricter than lists strictly require — name isn't a list's identity,
  so a second "Recipes" under a different parent is legitimate — but a Create row
  competing with an identical row right above it reads as a mistake far more often
  than as intent, and the deliberate-duplicate case still has Settings → Lists.

**Locked and hidden lists stay pickable — the pickers filter only `TRASH_ID`.**
They deliberately do **not** prune the lock model's `hiddenListIds` (the whole
lock/hide model — coverage, the two enforcement edges — is
[locks.md](./locks.md)). Hiding a
list is a pure **sidebar** declutter (`_panes/sidebar.tsx`, `pruneHidden` over
`useLocks().hiddenListIds`); it never blocks filing a link into a list you know
exists. Two reasons the pickers must ignore it: (1) locks are **device-local**
(the `LockRecord` model, see `lock-provider.tsx`), so the extension editor can't
know a web device's hidden lists — pruning them web-side would just make the two
apps' pickers disagree; (2) hide was never a content guarantee anyway. That's
what a **lock** is: `lockedListIds` folds into the link query's `lists.none`, so
a locked list's _links_ drop out of every read path (browse, Show All, tags,
search, pins) until unlocked — but the list stays selectable as a _destination_.
So: lock gates a list's contents; hide only tidies the sidebar; neither touches
what the pickers offer. Don't re-add `hiddenListIds` to any picker's
`excludeIds` — it looks like a privacy fix but only breaks web/extension parity.
The bracemark-expo share sheet follows the same rule: its taxonomy
(`buildShareLists`) filters only Trash and never reads locks.

**The coupling to watch** — the reason an editor change reaches beyond the
editors:

- **The row menu's "Move to"** (`_layouts/shared.tsx`, `LinkRowMenu`) renders
  `ListCommand` **directly** — the same component `ListSelect` wraps. So a change
  to `list-command` (its props, its row shape, its `excludeIds`/`disabledIds`
  handling) hits the move-to menu too, not just the editors. It passes
  `excludeIds={[TRASH_ID]}` and `disabledIds={[link.listId]}` — trashing is the
  menu's Remove, never a "move", and the current list stays visible-but-disabled
  to keep the tree's shape intact. It does **not** pass `onCreate`: this menu
  re-files an existing link, and a Create row inside a _destination_ picker is a
  different intent wearing the same clothes.
- **The Lists settings "Move to"** (`_lists/lists-section.tsx`, `RowActions`)
  also embeds `ListCommand` — but it **reparents a list**, not a link, so it uses
  two things a link-move never does. It opts into `ListCommand`'s **`root`** prop
  to offer a "Top level" target (`parentId === null`, which has no list id — the
  reason `root` exists rather than a sentinel id); and its `excludeIds` is the
  row's whole **subtree** (`forbiddenParentIds` — self + descendants + no-children
  containers) so a list can't move under itself (cycle) or into Trash, with the
  current parent left visible-but-disabled (`value`/`disabledIds`) like the link
  menu. Because the pick comes from a `CommandItem` (not a `DropdownMenuItem`,
  which Radix would auto-close), that menu is **controlled** and closes itself on
  select — same pattern as `LinkRowMenu`. Drag-and-drop with depth projection is
  still the _primary_ reparent gesture there; this menu is the keyboard/mouse
  fallback. It must never pass `onCreate` either — this picker chooses a
  **parent**, so "create a new list" inside it is incoherent twice over.
- **The rule the two menus above share**: `list-command`'s optional props split
  its audiences, and the split runs in both directions. `root` is for
  **reparenting** only (leave it out on link surfaces); `onCreate` is for
  **editors** only (leave it out on both move-to menus). Adding a fourth consumer
  means deciding both, not copying the nearest call site — and a future bulk
  "Move to" (see below) is a _menu_, not an editor.
- **The row menu's "View note"** is the reason the edit dialog takes a
  `focus?: 'tags' | 'note'` (`LinkEditRequest` in `view-state-provider`) rather
  than the boolean it started as. **The note has no read-only surface** — viewing
  it IS opening the editor on that field, which is why the item routes to
  `openEditor(link, 'note')` exactly as "Edit tags" routes to `'tags'`. That's a
  deliberate no: a separate note dialog would need its own page-level hoisting
  and `engaged` handling (rows are virtualized and repaint under sync — see
  invariant 4), and at `LINK_NOTE_MAX` a `Textarea` reads as well as a viewer
  would, with the edit already in hand. The item shows only when `link.note` is
  set (adding one is plain **Edit**) and is absent from the Trash variant, like
  the other edit affordances. A new "land focused on X" entry point should widen
  this union, not grow a surface. On bracemark-expo the same items push `/edit-link`
  with the same `focus` union as a route param — with one native divergence:
  `focus` **scrolls** the field into view instead of focusing it, because
  focusing a native input summons the keyboard over the very note "View note"
  came to read (web's `focus()` has no such side effect).
- **The layouts show the note as a badge, never inline.** Both are FIXED-height
  (`ROW_HEIGHT` — the virtualizer's estimate must stay exact), so a note line
  can't be conditional: it would be budgeted on every row, noteless ones
  included, and most links have none. So each row renders `NoteBadge` beside
  `PinnedBadge` — card (280) and list (70) alike — carrying the text in `title`
  for hover, with "View note" above as the real read path. This is a deliberate
  trade against `note`'s own rationale in `entities.ts`, which caps the field
  (`LINK_NOTE_MAX`) precisely so it CAN be shown in a list view; the density won.
  If that's ever revisited, the card layout is where the line fits (one clamped
  `text-xs` line ≈ +20px, `ROW_HEIGHT` 300) — and its budget comment has the
  arithmetic. Either way the field must stay inline on the link: were it to move
  to a `files/` blob (the deferred `noteId`), the layouts would lose the cheap
  read that makes even the badge possible.
- **The sidebar** (`_panes/sidebar.tsx`) does **not** use the shared picker
  components — it renders its own `NavTree`. But it renders it over the **same
  `useLists`/`useTags` trees** and the same `@stxapps/shared` tree helpers
  (`flattenTree`, `TreeNode`, `ancestorIds`). So the split is: a change to the
  picker _components_ does not touch the sidebar, but a change to the taxonomy's
  _shape_ (the entity schema, the tree helpers, the ordering/`parentId` model)
  hits the sidebar, the settings sections, and every picker at once. The sidebar
  also auto-expands an ancestor path when the selection changes (`expand`), so a
  list/tag chosen from an editor's `ListSelect` is never hidden under a collapsed
  parent.

### invariants every editor must uphold

These are the four rules the modal editors share. They exist because an editor is
**ephemeral draft state over a live, syncing store** — the store can change under
the form, and a stray click can drop the form.

**1. On open, copy values into draft state — don't bind to the store.** The edit
dialog snapshots `link.customTitle`/`listId`/`tagIds`/`note` into `useState` at
mount, and is `key`-remounted per open (and per retarget) so the draft always
starts fresh from the link. The quick-add popover resets its fields on
`onOpenChange(next=true)`. The reason is the writer-split + LWW: a background
extraction or another device can write the link mid-edit; a draft snapshot means
Save computes a **minimal patch** against the freshest blob
(`useLinkMutations.update` re-reads before merging) instead of binding to and
resurrecting stale fields.

**2. Validate inputs — cap text, resize images.** Two enforced facts:

- **Text caps** are `LINK_TITLE_MAX` (300) and `LINK_NOTE_MAX` (500) from
  `@stxapps/shared`. The editors set them as `maxLength` on the `Input`/`Textarea`
  (the friendly front-line), and the **entity schema enforces the same cap**
  (`z.string().max(LINK_TITLE_MAX)` on `customTitle`, `.max(LINK_NOTE_MAX)` on
  `note`) so a malformed write can't slip past. Discovered titles are capped by
  `cleanTitle` on the extraction side — same constant, so an override and an
  extracted title are bounded identically.
- **Image resize** is centralized in the data layer, not repeated per editor. The
  edit surfaces are the only ones that pick a custom image; each routes the pick
  through its platform's `useLinkMutations.saveCustomImage`, which caps
  dimensions via `resizeImage` before the blob lands in `files/{id}.enc` — web's
  is bytes-in/bytes-out (`packages/web-react/src/lib/resize-image.ts`,
  `createImageBitmap` + `OffscreenCanvas`), expo's is uri-in/uri-out
  (`packages/expo-react/src/lib/image.ts`, expo-image-manipulator — file
  bytes never enter the JS heap), both to the same spec: longest side ≤ 1024,
  re-encoded JPEG. `resizeImage` never throws — an
  undecodable input (SVG, corrupt bytes) falls back to the original, so a resize
  hiccup costs a larger blob, never the pick. **Any future editor that accepts
  image bytes must route them through `saveCustomImage` (or call `resizeImage`
  itself) — the per-user byte quota is the only backstop otherwise.** This is the
  same client-thumbnailing step the two capture tiers run
  (`server-extraction.ts`, the extension's `extraction-worker.ts`); the
  `bracemark-extractor` server deliberately never resizes (link-extraction.md). One
  exception by design: the extension's full-page **screenshot** capture is stored
  full-fidelity, not thumbnailed — resize's 1024px/JPEG spec is a preview spec,
  wrong for a faithful visual record.

**3. Guard the close so a stray click can't lose work.** The dialog and the
popover both compute a `dirty` flag that mirrors the patch Save would write
(`isDirty` in the dialog, `advancedDirty` in the popover), and **swallow only the
accidental close vectors** — backdrop click, Escape, the corner X — while dirty.
The explicit **Cancel** button calls `onClose`/`onOpenChange(false)` directly,
bypassing the guard, so a deliberate discard stays one click. Note the dirty check
is the _same_ field-by-field comparison the patch builder uses, so "dirty" means
exactly "Save would write something" — an untouched Save is a no-op that never
bumps `updatedAt` (which would reorder the date-modified sort). The extension's
popup editor has **no** close guard: a browser popup's close is the platform's
(it dismisses on focus loss, not interceptable), and it's create-only, so there's
less to lose — don't assume the invariant holds there.

### bulk edit

Bulk edit is a **mode**, not a separate editor: the topbar toggles `bulkEditing`
in `view-state-provider`, rows swap their options-menu slot for a `LinkRowSelect`
checkbox (`_layouts/shared.tsx` — sized to the menu trigger's footprint so row
geometry doesn't shift), and the `BulkEditToolbar` acts on the hoisted
`selectedLinks` map (keyed by the stable `link.path`).

- The selection lives in `view-state-provider` (not in a layout) because rows are
  virtualized — a layout-owned selection would be lost on repaint. `bulkEditing`
  is also one of the six guards that hold a background sync back, so rows can't
  shift mid-multi-select.
- **Navigating to another view exits bulk-edit mode.** Remove and Delete
  permanently mean different things per view, so a selection made in one view can
  never be acted on from another.
- **Select all** (checkbox left of the count) selects every loaded row — the
  toolbar takes `links`, the same useLinks page Main hands the layout. Bulk-edit
  mode holds `engaged`, so sync can't grow or reorder that page underneath;
  "Show more" can grow it, dropping the checkbox to indeterminate. Unchecking
  clears the selection without leaving the mode.
- **The toolbar mirrors the row menu over the whole selection**, with the same
  view split. **Copy links** is common to both views (the row menu's Copy link
  over the selection: URLs newline-separated, in display order; reads only, so
  trashed links are included). In Trash: **Restore** (→ My List — the schema records no previous
  list, same as the row menu) and **Delete permanently** (irreversible →
  `requestDestroy` → `LinkDestroyConfirm`). Elsewhere: **Move to** (the same
  searchable `ListCommand` as the row menu's submenu — no Trash target, no
  `onCreate`/`root`, per §"shared pickers"; the selection's single shared list,
  when there is one, shows checked-but-disabled), **Edit tags** (below),
  **Pin**/**Unpin** (Pin pins only the not-yet-pinned so existing manual pin
  ranks aren't churned; Unpin the inverse), **Archive** (flipping to
  **Unarchive** in the Archive view), and **Remove** (a reversible
  `update({ listId: TRASH_ID })`, no confirm). Buttons disable rather than
  disappear when their target set is empty, so the toolbar never reflows
  mid-multi-select. What varies is how much of each button is **shown**, in two
  tiers keyed off the toolbar's own measured width — never off the selection, so
  neither can shift under the user: below `COLLAPSE_WIDTH` the secondary actions
  fold into a ⋯ menu; below `ICON_WIDTH` the three that stay inline (Copy, Move
  to, Remove) drop their labels for square icon buttons, keeping their names in
  `aria-label`/`title`. That second tier is what fits the fixed set on a phone
  without pushing the one irreversible-looking action into a menu.
- **Non-Trash-view actions skip trashed links.** The All view and tag views can
  hold trashed links, whose own row menu allows only Restore/destroy; the
  toolbar is keyed off the active view, so each action instead filters
  `listId === TRASH_ID` out of its targets — per-link parity without per-link
  buttons. Every action also drops links already in its target state, so it
  never writes a no-op patch (no `updatedAt` bump reordering the date-modified
  sort).
- **Bulk Edit tags** (`BulkTagsDialog` — hoisted at the page level like the edit
  dialog, driven by `retagging` in `view-state-provider`) seeds one `TagsField`
  with the **intersection** of the selection's tags and saves the **diff**:
  added tags are added to every link, removed seed tags are removed from every
  link, and a tag only some links carry is never shown and never touched — a
  bulk edit can't strip tags the user couldn't see. An all-identical-tags
  selection degenerates to plain edit-in-place. It upholds the §invariants
  (copy-to-draft, dirty close guard, minimal per-link patches).

**On bracemark-expo** the mode is ported with the same selection/action semantics
(`features/links/` — `view-state-provider` holds the selection and the hoisted
`retagging`/`destroying` requests; `useLinkMutations`/`usePinMutations` live in
`@stxapps/expo-react`), with phone-shaped chrome: entry is the ⋯ menu's
"Select links" (no topbar slot), the toolbar is the **bottom-anchored**
`BulkEditBar` rendered by Main (✕ / count / Select all in its top row, actions
below; Android back exits the mode), the secondary actions sit behind a ⋯ menu
at every width (web's `COLLAPSE_WIDTH` split, fixed — a phone is always below
it, as it is below web's icon-only `ICON_WIDTH` tier), Move to is a dialog embedding the native `ListCommand` cousin instead of
the anchored submenu (`features/links/move-to-dialog.tsx`, shared with the row
menu — same `excludeIds`/`disabledIds` wiring, no `onCreate`/`root`; the Lists
settings reparent dialog embeds the same body with `root`, like web), and the
bulk tags dialog seeds the same native `TagsField` cousin the in-app editors
render (like web's seeds `TagsField` — filter input and reuse-or-mint Create
included; the single-link case no longer rides this dialog anyway — the row
menu's Edit tags pushes `/edit-link` focused on tags, like web). Web's
shift-click `selectRange` has no touch analogue and is not ported.

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
| web quick-add              | `apps/bracemark-web/.../links/_components/link-add-surface.tsx` | create    | URL, then list/tags/note behind a disclosure       |
| web edit dialog            | `apps/bracemark-web/.../links/_components/link-edit-dialog.tsx` | full edit | title, list, tags, note, image                     |
| bracemark-expo quick-add   | `apps/bracemark-expo/src/features/links/link-add-panel.tsx`     | create    | URL, then list/tags/note behind a disclosure       |
| bracemark-expo edit screen | `apps/bracemark-expo/src/features/links/link-edit-screen.tsx`   | full edit | title, list, tags, note, image                     |
| bracemark-expo share sheet | `apps/bracemark-expo/src/features/share/share-screen.tsx`       | create    | list, tags (URL/title arrive in the share payload) |

**Every create surface gates on the plan's link cap, because nothing behind them
does.** Free's 200-link wall is enforced HERE and only here: `files/sign` keeps a
byte/object backstop and no longer counts links ([iap.md](./iap.md),
_enforcement_), so a save that gets past a create surface syncs and stays. All
four create surfaces therefore refuse at the cap. The three **in-process** ones
read `useLinkQuota` and render `LinkQuotaBanner` + an upgrade CTA **instead of**
the form — web quick-add, the browser extension's popup, bracemark-expo's add
panel (that hook's header is the canonical rationale; it counts
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

**Web quick-add is one form in two containers, split at `md`.** Above the
breakpoint it is a popover anchored to the topbar's Add button; below it, the same
form fills a bottom sheet. The split is about the **soft keyboard**, not the width.
The URL field is `autoFocus`, and `PopoverContent`'s height cap is computed by
Floating UI against the **layout** viewport — the one the keyboard does not shrink
([safe-area.md](./safe-area.md), _what's provided_). So an anchored popover believes
it has the whole screen, and with the optional fields open its Save button — the control that
completes the task — sits under the keyboard, inside a scroll container that doesn't
know it's clipped. A bottom sheet does not fix that by itself, since `position:
fixed` anchors to that same layout viewport; what fixes it is lifting the sheet by
the occluded height measured off `useVisualViewport` ([safe-area.md](./safe-area.md),
_popups & dialogs_ (2) — the hand-rolled-geometry case). Two consequences worth
keeping: all draft state lives **above** the container fork, so crossing `md`
mid-edit (a rotation, a resized window) swaps the shell without dropping the draft;
and the sheet passes `SheetContent`'s `onClose` so its X reaches the unguarded
close, because the built-in `SheetClose` routes through the dirty guard below and
would silently no-op on a dirty draft (invariant 3 — the corner X is a deliberate
door). The **trigger** does not move — Add stays in the
topbar at every width. bracemark-expo's FAB is a different affordance for a
different frame; the two clients agree on the form, not on where it is summoned
from.

**The optional fields are named for themselves, and collapsing them does not
discard them.** The disclosure reads **"List, tags & note"**, not "Advanced":
nothing behind it is advanced — filing a link into a list is the most ordinary act
in the product — and the novice/expert axis that earns the word on advanced
_search_ (a plain box vs. the full grammar) has no counterpart here. URL is the one
required field; these three are the optional ones, and the label says which three
so the collapsed state needs no guessing. "More options" was unavailable in any
case: it is the topbar overflow button's name, one row up
([brand-assets.md](./brand-assets.md) is the record for user-facing wording). The
state is `openOptional` / `optionalSet` / `optionalDirty` in both files, so the
code says what the button says. The trigger is quiet by weight and one step of
colour — `font-normal` and `text-foreground/70`, never a smaller type size, and
never `text-muted-foreground`, which is what the Field labels under it wear
([theme.md](./theme.md), _contrast_ — the ghost variant's `hover:text-foreground`
lifts it to full on hover). The dot matches the label's colour.

Both quick-add surfaces keep
`listId`/`tagIds`/`note` when the disclosure shuts, and Save writes them whether it
is open or closed. A disclosure discloses — it doesn't arm — and people close it to
reach Save without scrolling, or to get the sheet clear of the keyboard, so
answering that with a silent revert would be the worse failure of the two: Save
writes a record, and there is no undo. It could not be a clean rule anyway, because
`listId` is never empty (it starts at the viewed list and is always written), so
"collapsed means ignored" would have to mean "collapsed means back to My List". What
the hidden state does need is to stay **visible**: the trigger carries a dot while
the section is shut and holds something (`optionalSet` in both files), the same
answer the advanced-**search** trigger gives to the same problem
([search.md](./search.md)) — the same 6px dot, but `bg-foreground/70` rather than
that one's `bg-primary`. The search trigger is an icon button, where the dot is the only
thing that can carry the state and has the whole box to itself; here it is
punctuation beside a label, and an accent-coloured one would outweigh the label it
modifies and make a 6px dot the loudest thing in the form. The dot is decoration;
`aria-label` is what reaches a screen reader, as a name rather than a live region,
since it re-words as the note is typed ([accessibility.md](./accessibility.md)).
Discarding on collapse would also quietly break invariant 3 below: `optionalDirty`
is derived from those same fields, so a reverting collapse would disarm the close
guard exactly when a draft was in hand.

The two bracemark-expo in-app editors are the web pair's behavioral twins (same
validation, same quota banner on create, same dirty close guard) presented
phone-shaped — but they are presented by **different mechanisms**, and only one
of them is a route.

The **edit** editor is a modal-presented expo-router screen: `/edit-link`,
pushed by the row menu with a `linkId` + optional `focus` param
(`presentation: 'modal'` — an iOS page sheet, an Android slide-up). A router
screen, not an RN `Modal`, so it inherits the screens'
`KeyboardAwareScrollView` path for free and portalled dialogs work inside it
(docs/soft-keyboard.md — the presentation decides the keyboard mechanism), and
its accidental close vectors (swipe-down, Android back) are swallowed while
dirty by `usePreventRemove`.

The **add** editor is **not a route at all**, and that is a load-bearing
decision rather than an accident of history. `link-add-panel.tsx` is an absolute
layer the links screen draws over itself while its own `adding` state is true
(the FAB flips it); its header carries the three measured facts that pushed it
out of expo-router, all of them silent — a `fitToContents` form sheet has no
Android half once the keyboard is up, a fitted sheet may hold no scroller (which
costs two of the three keyboard-dismissal paths), and presenting a transparent
modal route a second time drops the WHOLE app's accessibility tree. What the
route was providing it now provides itself, one line each: a fresh draft per open
(the links screen mounts it only while `adding`), Android's hardware back via a
`BackHandler` that swallows the press while the optional section holds work, and
modality for a screen reader (`accessibilityViewIsModal` on iOS, the links screen
hiding its own subtree on Android). Its backdrop is web's outside-click and is
guarded the same way. → docs/soft-keyboard.md, _the add panel_.

Two structural consequences: the edit screen
needs **no hoisted `editing` view state** (web hoists its dialog because
virtualized rows repaint under it; a pushed screen isn't row-anchored and its
draft is a snapshot), and its custom-image flow is **uri/path-based end to
end** (expo-image-picker → `resizeImage` uri→uri → `saveCustomImage` →
`writeFile` path-to-path copy) — file bytes never enter the JS heap, the
platform's file-store doctrine. They can't render the web pickers (`web-ui` is
`platform:web`), so they share **in-app native cousins** in
`apps/bracemark-expo/src/components/links/` (`list-select.tsx` over the shared
`list-command.tsx` body and `tags-field.tsx` over `tags-command.tsx` — the same
two shell/body splits as web, with dialogs standing in for anchored popovers —
plus `link-quota-banner.tsx`) wired to `@stxapps/expo-react`'s live hooks. The
row each control sits in is shared too: `labeled-field.tsx`, the cousin of web's
`<Label density="dense">` over a control — not of web-ui's `ui/field.tsx`, which
neither platform's link editors use.
**The tag option set never renders inline in an editor.** It used to — every tag
as a wrapped chip, unbounded — and on an account with forty tags it pushed the
add panel's Note and Save off its keyboard-shortened height, the same defect the
share sheet's compose screen had (`share-tags-picker.tsx`). On web, `TagsField`
is a one-line token-combobox trigger capped to two removable selections plus `+N`; on
expo it is a fixed one-line summary matching `ListSelect`. Both open a capped,
searchable `TagsCommand` whose full-width checkbox rows stay open across presses
(tags are a set) until Done. `BulkTagsDialog` renders `TagsCommand` directly on
both platforms, being a dialog that holds nothing else. Unlike
the share sheet's snapshot-fed pickers, these run in-process and therefore
follow the web rule: they create **immediately** (top-level, index 0,
case-insensitive reuse) — see "web pickers create IMMEDIATELY; the share sheet
DEFERS" below.

Both full editors preview the custom image in **the card banner's slot** —
`aspect-12/7`, full width, the ratio `card-layout.tsx` / `link-card.tsx` lay
their banner out at. The editor is the
only place a user chooses an image and nowhere lets them choose its crop, so the
preview owes them the crop the app will actually apply; the list thumb's 8:5 is
near enough that the card, the one surface showing the image large, is the one
worth previewing. Neither app did this before — web's `max-h-40` let the box take
the IMAGE's aspect (so `object-cover` was inert for landscape and the field
resized per image), and expo's `h-40 w-full` cropped harder than either surface
it was previewing.

**The image field is LAST, and full width because it is last.** Both editors run
title → list → tags → note → image. The middle three are exactly what the create
surfaces collect, in the same order, so the two fields only a full edit has
book-end that run rather than splitting it — and the field a link rarely carries
an override for sits past the ones edited on every visit, which is the same trip
the row menu's "Edit note" exists to skip (below). It used to sit second, capped
at `max-w-80` (320 → 187 tall), because a full-width 12:7 preview is 233px in the
dialog's 400px body and crowded List/Tags/Note out of a region that already
scrolls. With nothing after it, height costs only a scroll taken by someone who
came for the image, so the cap goes — and with it the ~80px of dead space beside
the preview, which the buttons could only have filled by taking the preview to
~212 wide, too small for the one thing the field exists to show. The buttons stay
**below**, sharing the form's single left edge with the label and the preview,
which is what makes three elements read as one field; full width also puts the
preview on the same right edge as every input above it. The cost is
discoverability for a field now below the fold — if that bites, widen the `focus`
union (below) rather than grow a surface.

**The slot holds its size when there is no image**, showing a dashed box with a
line of muted copy instead of collapsing to that line. The Choose/Reset buttons
sit BELOW the slot, so without it they move under the pointer twice over: up when
clearing an override with no extracted fallback, down when the LIVE read
(`useLiveQuery` / `useLiveRead`) behind the stored image materializes bytes
mid-edit. Moving the field last retired its other two reasons, both of which were
about a growing field shoving what came after it — the note sliding out from
under someone typing in it, and on expo `focus` scrolling to a field's `layout.y`
once, off that field's first layout, so an image resolving later left "Edit note"
scrolled short of the note. Nothing follows the image now, so keep the fixed slot
for the buttons, and keep it in mind if the order ever changes back.
The empty copy is "No image — cards show a colored panel", not "no preview
image", because an image-less card is **not** blank (`LinkPreviewImage`'s `panel`
fallback paints the host's hue — link-extraction.md) and because the same state
covers a blob this device hasn't materialized yet.

**The Cancel/Save footer is a content-width row on the right, at every width**:
a ghost Cancel, then the filled Save, with Restore between them when quick-add
matches a trashed link. Web quick-add and both bracemark-expo editors build that
row by hand (`justify-end gap-2`). The two web dialogs, edit and bulk "Edit tags"
on both platforms, use `DialogFooter`. Its base class is shadcn's
`flex-col-reverse … sm:flex-row`, which stacks a full-width Save over a full-width
Cancel below `sm`, so they pass `className="flex-row justify-end"`. They used to
take that default, which nobody had chosen, and were the only editors whose
footer changed shape on a phone.

The stack is the **prompt** shape: the dialog asks one thing and its full-size
buttons are the answers. The destroy confirms, the lists/tags delete confirm
(`table-kit.tsx`), the paywall, `lock-password-dialog.tsx` and expo's
`time-field.tsx` keep it. So does a lone full-width **Done** that closes a picker
(expo's `tags-field.tsx`, the share sheet's pickers), which has no pair to rank.
On an editor the stack costs a second row exactly where height runs short. It
also makes a ghost Cancel as big as Save, when Save should be the loudest button
in the footer. Nothing flags a stacked footer, so check it below `sm` when you
add an editor.

**…and the footer is PINNED, never the scroller's last child.** Only the fields
scroll; the button row stays in view. Every editor here runs past the fold
somewhere: the full editors end on the 12:7 image preview, AdvancedSearch ends on
the Tags tree, and quick-add outgrows its keyboard-shortened sheet once "List,
tags & note" is open. A footer at the end of the scroll put Save a scroll away at
the moment the draft was finished. How each surface does it:

- **Web dialogs:** a `min-h-0 flex-1` body with `overflow-y-auto` above
  `DialogFooter`.
- **Web quick-add and the advanced-search popover:** a scroll box of fields,
  bled out with `-mx-4 px-4 -my-1 py-1` so its clip doesn't cut the ghost
  disclosure's overhang or the focus rings.
- **The expo add panel:** its footer sits below the panel's `shrink` scroller.
- **The two full-screen expo editors:** `components/sticky-footer.tsx`, a bar
  that also rides the keyboard ([soft-keyboard.md](./soft-keyboard.md), _the
  sticky footer_).

The bulk-tags dialogs never needed the change, because `TagsCommand` scrolls its
own rows.

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
  with live depth projection, a "Move to" picker (a submenu at `md` and up, a
  dialog/sheet below — §"the shared pickers"), and collapse toggles.
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

  **A native drop is held until the new order renders — never for a fixed
  time.** Finishing a drop takes two changes on two threads: the drag transforms
  go back to identity (UI thread), and the rows re-lay-out in their new order (the
  write, the live-read re-run, a React commit). Either one alone is a glitch —
  identity over the old layout is every row back where it started until the read
  lands; the new layout under the old transforms is each row shifted twice — and
  the round trip is tens of ms on a release build and several hundred on a dev
  one, so a settle timer is wrong on one of them whatever its value (it was
  140ms, and a dev build on a phone showed the old order after every drop). So
  `drag-sort.tsx` flies the row into its slot and then holds that pose, which is
  the order about to arrive, until the section's `orderKey` changes; the reset is
  queued from that commit's own layout effect, which is the closest JS gets to
  sending the two together — and is not close enough, see the next paragraph.
  The contract this puts on a section is two lines: pass an `orderKey`
  that changes when a drop lands (the ids in order; Lists adds each row's depth,
  since a drop can re-nest a row without moving it), and have `onDrop` **return
  the write's promise**, or nothing for a drop that changes nothing — the no-op,
  the paywall. Nothing returned, a rejected write, or 1.5s with no new order
  sends the row back home instead, and a pick-up is ignored while a drop is
  still held, since every index is about to change under it. The lifecycle is
  spec'd with the gesture's callbacks driven by hand (`drag-sort.spec.tsx`);
  that the two halves land in the same FRAME is not something jest can see — it
  is judged on a device.

  **Judged on a device, they don't: a drop that lands still paints the
  double-shifted pose for a frame, and that is Reanimated's doing, not a missing
  case in the hold.** What shows is the rows between the old slot and the new one
  flashing each other's names — the dropped row a second travel's distance past
  its slot, its neighbours one row off — and then the right order. An earlier
  version of this section said the layout effect makes the reset and the new
  layout "reach the UI thread together". They do arrive together; the reset is
  then refused. Read from the installed source (reanimated 4.1.7, worklets 0.5.1,
  RN 0.81.5), the sequence is:
  1. React commits the rows in their new order. Inside that commit Reanimated's
     commit hook re-stamps every animated view with the props it last applied —
     here the hold pose — so a React commit can't wipe a running animation, and
     **pauses its own commits** until that tree has mounted
     (`ReanimatedCommitHook`).
  2. The layout effect runs after that stamp, so it is already too late to change
     what the tree carries. `scheduleOnUI` is batched on a microtask, RN's event
     loop runs microtasks before it hands the mount over, and so the reset reaches
     the UI thread just AHEAD of the mount — where it is recorded and not
     committed, because commits are paused (`performOperations`).
  3. The mount paints the new layout under the stamped pose: each row shifted
     twice.
  4. The mount hook lifts the pause and asks for a flush on the NEXT frame
     (`ReanimatedMountHook`); identity lands there.

  So it is one frame at the least, more when the UI thread is busy, and on every
  drop that lands — "sometimes" is how often a single frame is noticed, and a
  long move shows more than a short one. The frame count is read from the source,
  not sampled. It is the price of the hold rather than a regression beside it:
  the 140ms timer never showed it, because its reset had long since landed by
  the time the order rendered — it showed the old order instead, for far longer.

  It stays, because nothing that removes it is worth a one-frame flash in two
  settings tables whose buttons reorder without it:
  - **`DISABLE_COMMIT_PAUSING_MECHANISM`** (a reanimated static flag, set under
    `reanimated.staticFeatureFlags` in the app's `package.json`) is the real fix —
    without the pause the reset commits over React's newest tree and the two mount
    as one transaction. But it is app-wide, it is a native rebuild, and
    reanimated's docs call it safe only with RN's
    `preventShadowTreeCommitExhaustion` on, which in 0.81 defaults off and is
    turned on by patching a header in `node_modules`; without it the flag can
    starve React's commits and hang the app. **Revisit when an SDK bump brings an
    RN where that flag is the default** (`dependency-upgrades.md`).
  - **A synchronous reset** (`runOnUISync` from the layout effect, so the
    re-render `onRelease` causes is stamped with identity) does not work: a style
    update only enters the registry the commit hook reads on Reanimated's next
    UI-thread flush, which a call made from the JS thread never runs.
  - **Remounting the rows in the commit that lands the drop** — a fresh view has
    no entry to stamp — is the one route that needs no flag. Untried: every row
    remounts on every drop, and a fresh row's first style is computed from shared
    values that still describe the held drag, so it needs its own guard.
  - **Rendering the rows in a fixed order and positioning them from the UI
    thread** removes the pairing altogether, and with it the order a screen
    reader walks the table in.

  **Web has the same gap and closes it from the other side: the new order is in
  the drop's own render, ahead of the write.** dnd-kit drops its transforms in
  the render `onDragEnd` runs in and has no pose to hold — its rows stay put
  through that render only if the list it sorts has already been reordered,
  which is why its own examples `setItems` in the handler. Here the order comes
  back through a Dexie write and `useLiveQuery`, a render or two later. An
  earlier pass at this measured whether the OLD ORDER was ever painted, found it
  wasn't below 6× CPU throttle, and called the gap hidden. That was the wrong
  question. The old order is not painted; what happens is that dnd-kit sees a
  drag end with nothing moved, starts easing every row home, and then reads the
  late reorder as a layout change and replays each moved row from where it sat
  BEFORE the drag. Sampled per frame in headless Chrome against the dev server
  with no throttling at all, the rows that had made room jumped back a full row
  and slid into place again over ~150ms — on every drop, on any machine.

  So `useDropHold` (web `table-kit.tsx`) takes the order the section is about to
  write and renders THAT from the drop's render on, until the live read's order
  key equals it; the swap back is then the same rows in the same places. The key
  is expo's `orderKey` — the ids in order, plus each node's depth on Lists, where
  `applyMovePlan` (`sync/tree-dnd.ts`) predicts the forest the plan will produce.
  A rejected write lets go at once, and 1.5s without agreement is the backstop,
  as on expo. It holds until the read MATCHES rather than until it changes,
  because a reorder can be several writes and each is its own read. Measured the
  same way after: no row but the dragged one moves a pixel across the drop, at
  1×, 6× and 20×, in both directions, for a reorder and for a re-nest. The
  lifecycle is spec'd in `table-kit.spec.tsx`; the frames are a browser's to
  judge, and the dragged row itself still snaps the last few px from the pointer
  into its slot, which is dnd-kit without a drag overlay.

  Lists opts out of dnd-kit's layout animation in one case, because the hold
  exposes it: a dragged row's subtree leaves the table while it travels and comes
  back in the drop's render, so the rows below the new slot are suddenly lower by
  the subtree's height. Animated, they slide there for 200ms underneath children
  that mounted in place at once. `animateLayoutChanges` in `lists-section.tsx`
  turns the animation off when the row count changed, so they move with the
  children, as they do under a collapse toggle.

  **A one-row drag is one write, whichever way the row went.** Tags hand
  `reorder` the whole group in its new order (so does expo), and
  `rerankToOrder` (`sync/rank.ts`) keeps the rows already in order and re-ranks
  the rest. It used to pick those anchors greedily from the head, which is
  minimal only for a row dragged DOWN. A row dragged up became the leading
  anchor, out-ranked everything below it, and every other row was re-ranked: n −
  1 encrypted files for a one-row move, written one transaction at a time, with
  a live read and a repaint after each. A six-tag table painted seven orders over
  ~300ms after one upward drop. The anchors are now the longest ascending
  subsequence, so it is one write in either direction (`rank.spec.ts` walks every
  from/to pair). This is what expo's hold was already relying on: it lets go on
  the FIRST change of `orderKey`, which is only the final order if the drop was a
  single write. A bulk sort is still several writes and still repaints per write
  on both platforms; nothing holds that, and nothing has needed to.

  The exception is a tag drag across **three or more tied ranks**. A tie can only
  anchor one of its rows, so the rest are re-ranked — several writes for a one-row
  move — and not every one of them leaves the order alone on the way: with three
  tied tags `x y z`, dragging `x` to the bottom writes `y` and then `z`, and the
  table reads `y x z` between the two. Expo's hold lets go on that first change,
  so the wrong order stays up for a whole write and read, not a frame; web is
  unaffected, since `useDropHold` waits for the order to MATCH. Simulated
  against `rerankToOrder` rather than spec'd, and left alone — a tie takes two
  devices or an import to make. The fix when it's wanted is web's: hold until
  `orderKey` equals the order the drop predicted. A Lists drop goes through
  `move`, whose write order (next paragraph) keeps the first change the final
  one.

  **A `move` is one write too — except into a slot between two tied ranks.**
  The up/down buttons, "Move to", a Lists drop and a pin's up/down all go through
  `move` (`moveBeside` for pins), which mints one key between the slot's two
  neighbours and writes only the moved entity. Two neighbours can carry the
  **same** key, though, and that is an ordinary state rather than a corruption:
  every create mints the head key of the root group (below), so two devices
  creating offline mint the same one, and a backup's lists arrive with keys minted
  in some other library. The sort breaks the tie by id, so the rows sit in a
  stable order with a visible slot between them — and no key is strictly between
  two equal keys. The single-key mint (`rankForIndex`) throws there, and what
  reached the user was fractional-indexing's bare `" >= "` in the section's
  notice: "Move up" on the row under a tied pair, on a seeded account whose root
  lists had been ranked from the same starting point as the My List / Archive /
  Trash defaults. So `move` asks `placeAtIndex` (`sync/rank.ts`) instead, which
  returns the moved entity's key plus the tied siblings that must be re-keyed to
  open the slot — the shorter side of the tied run, never a row that was not
  tied — and the hook writes those first and the moved entity last. In that
  order no write reorders the siblings among themselves, so the only change the
  live read paints is the move, and the first change of `orderKey` is still the
  final order whenever the tie is a pair. `rankForIndex` stays for what can never
  tie: a prepend or an append, which is every create and the import's resolvers.
  Nothing catches a regression here but `rank.spec.ts` and the pin specs — a tie
  takes two devices or an import to make, so no hand-built library has one.

  **What the two tables share is factored, once per platform.** The projection
  math is shared across platforms (above), but the _chrome_ can't be — a `<div>`
  and a `<View>` have no common ancestor — so each platform keeps one
  `table-kit.tsx` holding what its own two tables have in common: the create row,
  the inline rename field, the sort menu, the error runner (`useOpRunner`), the
  rename-focus dance, and on web the drag grip (expo's lives with its drag layer
  in `drag-sort.tsx`). Web's is `settings/_components/table-kit.tsx`, beside the
  `settings-kit.tsx` that owns the settings design system proper — the kit is the
  section-level system, the table kit is these two tables. Expo's is
  `features/settings/table-kit.tsx`, component for component. The split is the one
  this whole entry describes: what both tables agree on lives in the kit, what
  they disagree about (nesting) stays in the section. Pure ordering is neither
  platform's business and goes one level further out — `sortedByName` / `SortDir`
  in `@stxapps/shared` (`sync/sort.ts`), one copy behind all four tables.

  **Delete is checked, then confirmed or refused in a dialog — never in the
  section's notice.** Every other op reports through `useOpRunner`'s
  `SettingsNotice`, which sits above the table; that is fine for the create row
  (also at the top) and for rename/move, whose guards the UI already prevents.
  Delete is the one op that routinely fails from deep in the table — a list
  with links or sub-lists can't go — and on a long table the refusal landed a
  screen above the row that asked, so the click appeared to do nothing, and the
  message ("Move or delete its links first") didn't say whose. So a row's
  Delete calls the mutations' `destroyBlocker(item)` — the same guards `destroy`
  enforces, which now names and counts: "“Reading” still has 12 links. Move or
  delete them first." — and only then raises the kit's `DestroyConfirm`, a modal
  that shows either that refusal with an OK, or a destructive confirm. The check
  settles _before_ the dialog mounts, so it never opens as a confirm and turns
  into a refusal (`useDestroyRequest` holds the request by id and drops a check
  a newer one has overtaken). `destroy` still re-checks, since another device
  can file a link into the list between the check and the click; that refusal
  lands inside the dialog as a `role="alert"` line. The confirm is also new in
  its own right: deleting a tag strips it from every link on every device, and
  neither table asked before. On web the blocked face's OK is an
  `AlertDialogCancel`, not an Action — Radix's alert dialog focuses its Cancel
  on open and has no fallback, so without one focus opens stranded outside the
  dialog. Both kits carry a spec for the flow (`table-kit.spec.tsx`).

  **Everything else stays in the notice — but the notice comes to the reader,
  and a failed rename un-types itself.** The modal is for a REFUSAL THAT CARRIES
  A DECISION, which is Delete and nothing else: what can otherwise reach the
  runner is a local-store write failing, since every named throw in the
  mutations (`Trash cannot contain lists`, `a list cannot be its own parent`,
  an end-of-group move, a blank or unchanged rename) is a state the UI prevents
  before the call. That is not a decision, there is nothing to put in a footer
  but "OK", and rename commits on BLUR — four rows renamed against a broken
  store would be four modals to dismiss, where one notice persists until the
  next op. So two narrower changes instead, both in the kits:

  - `SettingsNotice tone="error"` **scrolls itself into view** when it appears,
    which is the sighted half of the `role="alert"` it already carried. Web
    uses `scrollIntoView({ block: 'nearest' })`, so a notice already on screen
    moves nothing; expo has no DOM to walk, so `scroll-host.tsx` grew
    `scrollIntoView(node)` — `measureLayout` onto the host's own wrapper, so `y`
    arrives in CONTENT coordinates and is compared against the window of content
    on screen (`offsetY` … `+ viewportHeight`), animated, and skipped when the
    notice is already visible. `info` and `pending` never move the page: they are
    standing text, not events.

    **Which frame each side of that comparison is in decides whether the expo
    half runs at all, and getting it wrong is silent.** `measureLayout` sums
    layout boxes up the tree and a scroll offset is not one of them, so comparing
    its `y` against the viewport's own box — the obvious reading of "is this on
    screen" — compares two numbers that never move relative to each other: driven
    on the simulator with the page a screen down, the notice measured 156 either
    way, so it counted as already visible every time and the method did nothing.
    There is no failure to see, only a page that stays put, which is
    indistinguishable from the bug the scroll was added to fix. Window
    coordinates for both sides is the other road and worse: the wrapper sits
    inside a `SafeAreaView`, which applies its insets as a native view outside
    Yoga ([soft-keyboard.md](./soft-keyboard.md), _the traps_), so measuring the
    node one way and the viewport the other mixes two frames a top inset apart.
    The rule is one tree and one frame — hence the content-coordinate comparison
    above, and hence the drag layer's window-coordinate `viewport()` being a
    SEPARATE accessor rather than one both callers share: it exists to be
    compared against a gesture's `absoluteY`, which is genuinely in the window.

    **The scroller has to declare the band its sticky bar covers, or the web
    half only looks like it works.** `nearest` aims at the SCROLLPORT's edge,
    and the settings topbar is `sticky top-0` _inside_ that scroller
    (`settings/layout.tsx`) — so a notice scrolled to the top edge landed
    behind 56px of bar, and one already behind it counted as visible and moved
    nothing at all. Neither case reports anything: the call fires, the promise
    of "the message comes to the reader" is broken, and the click reads as
    having done nothing — the exact bug the scroll was added to fix.
    `scroll-padding-top` on the scroll container is the fix (`scroll-pt-18`),
    because it takes the obscured band out of the scrollport's optimal viewing
    region for every scroll into the pane at once. The bar's `h-14` is a FLOOR
    under that number, not an equality: at exactly 56 the notice lands welded to
    the bar's hairline and still reads as chrome, so the padding is the band
    plus one step of air.
    It is deliberately NOT a `scroll-mt-*` on the notice: the bar's height
    belongs to the frame, and the kit stays layout-ignorant. Any surface that
    puts a notice under a sticky bar owes the same padding on its scroller.

    **And the menu the op fired from has to let go of the page.** Radix returns
    focus to a menu's trigger on close with a bare `.focus()`, which SCROLLS
    that trigger back into view — so a move launched from a row kebab a screen
    below the notice scrolled to the notice and was then dragged straight back
    to the row, the smooth scroll cancelled mid-flight (the restore runs from a
    timeout after the content unmounts, so it always lands second). Only the ops
    fired FROM the menu could show it: rename commits on blur, a beat after the
    menu is gone, which is why every other failure looked fine and move looked
    like the scroll had never fired. The row kebabs therefore own their whole
    close-focus — `useRowMenuFocus` in the web kit's `table-kit.tsx` prevents
    Radix's restore and refocuses the trigger with `preventScroll: true`,
    keeping the Rename branch that already handed focus to the inline field.
    Expo has nothing to mirror here: its menus restore no focus of their own,
    which is why its Rename already focused the field from a ref.
    Nothing is lost: the trigger was on screen when it was clicked, so the
    restore only ever had somewhere to scroll when the notice had moved the page
    first. The toolbar's Sort menu doesn't take this and doesn't need it — its
    trigger sits in the same block as the notice. Any menu whose trigger can be
    a screen away from a notice owes it. Both branches are spec'd
    (`table-kit.spec.tsx`); the movement itself was driven in a browser, since
    jsdom has no layout to scroll.

  - `RenameField` **puts the stored name back when the commit doesn't land.**
    The field is uncontrolled and the call site keys it on the STORED name, so
    a failed write changes nothing and the row goes on displaying a name no
    store holds — on every device, until the section is re-entered. A message a
    screen away cannot fix that; the table has to stop asserting the rename
    happened. Two commits revert: a blank name (which the mutations treat as
    "no rename", so nothing throws) and a rejected write. Hence `onRename`
    returns a promise and both sections pass `runAwait`, which records the
    message for the notice AND re-throws — the same contract CreateRow already
    used to keep its typed value on a failure. Web assigns `input.value`, expo
    remounts the field (RN has no `.value`), and both spell the three cases in
    `table-kit.spec.tsx`, positive control included.

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

| pair | shell                                              | body                               | data hook                       |
| ---- | -------------------------------------------------- | ---------------------------------- | ------------------------------- |
| list | `list-select.tsx` (`ListSelect`, a combobox)       | `list-command.tsx` (`ListCommand`) | `useLists` / `useListMutations` |
| tag  | `tags-field.tsx` (`TagsField`, a compact combobox) | `tags-command.tsx` (`TagsCommand`) | `useTags` / `useTagMutations`   |

All three link editors render `ListSelect` + `TagsField`, so the pickers stay
identical across web quick-add, the extension, and the edit dialog. That's the
point of the pairing — one picker over one live tree, no drift.

**A third shell sits beside the two above: `move-to-surface.tsx`
(`MoveToSurface`) — `ListCommand` in a container that stands on its own**, for
the callers and the widths where an anchored menu can't hold it. It takes
`ListCommand`'s props straight through (`value` / `excludeIds` / `disabledIds`,
and both opt-ins, `root` and `onCreate`, with no opinion on either — its two
callers pass opposite ones), plus a `title`, a `busy` line, and
a `wide` boolean that picks the container: a **centred dialog** at `md` and up, a
**bottom sheet** below it — the same fork, at the same breakpoint, that quick-add
makes between its popover and its sheet.

The measurement behind it: a `DropdownMenuSubContent` at `w-64` (256px) needs its
parent menu's `min-w-48` (192) plus two 8px collision gutters — **464px against a
375px phone**. Radix doesn't clip that; the submenu flips, then the shift
middleware clamps it to the gutter, so it lands _on top of_ the parent menu,
covering the row it grew out of. Two more things the arithmetic misses: a
hover-intent submenu is a mouse gesture, and the filter input — there past
`SEARCH_THRESHOLD`, and at any count where the caller can create — summons a
keyboard the floating layer cannot see (Floating UI measures the
_layout_ viewport, which the keyboard doesn't shrink — `docs/safe-area.md`,
_popups & dialogs_). Hence also `onOpenAutoFocus` prevented on the sheet: the
picker is a list first, a search box second.

**`wide` is a prop, not a `useMediaQuery` call inside the component**, and that's
load-bearing twice. The hook seeds `false` and corrects in an effect, so a
surface that mounts on interaction would flash a bottom sheet at a desktop user
for one frame; and the links page's row menus need the same boolean, one
`matchMedia` per page rather than one per virtualized row (it rides
`view-state-provider`'s `wide`; the settings section calls the hook itself).

**A picker embedded in a surface sits on that surface's text column.** Four
surfaces render a command body directly rather than behind a combobox —
`MoveToSurface`'s two branches, the web and expo `BulkTagsDialog`s, and expo's
`MoveToDialog` — and in each, what lands on the host's column is the filter
field's **border box** and the row highlight's **rect**, not the row text
(`CommandItem`'s `px-3` keeps that 12px further in; pulling _it_ out would hang
the highlight and its focus ring in the host's gutter, which is a full-bleed menu
and not what any of these are). Expo gets this for free — its pickers have no
panel padding — while web's `Command` is styled to _be_ a popover, so each web
host cancels the difference itself: `-mx-2` where the whole `p-1` is still on
(`BulkTagsDialog`), `-mx-1` on top of the `bg-transparent p-0` that
`MoveToSurface` already passes. **Both need `w-auto` beside the margin**, and
that half is the silent one: `Command`'s base is `size-full`, and a box with a
definite `width: 100%` does not grow into a negative margin — it _shifts_,
leaving one edge out by the full amount and the other in by it, under a grid, a
flex column and a block scroller alike. tailwind-merge won't warn (`size-full`
and `w-auto` aren't a conflict pair; it only drops a `w-*` that a _later_
`size-*` overrides), so the override rides on Tailwind emitting `size-*` ahead of
`w-*` — the same thing the `h-auto` in those class lists already depends on.

**Both pickers can CREATE, and the list create is opt-in.**
`TagsField` always mints (a tag editor with no way to make a tag is barely an
editor); `ListSelect` mints only under **`allowCreate`**, which the three link
editors pass. The rows themselves are `TagsCommand`'s always-on Create and
`ListCommand`'s **`onCreate`**-gated one — and `onCreate` is passed by **every
surface that files a link**: the editors through `ListSelect`, and the link
"Move to" surfaces directly (below). The one `ListCommand` host that must not is
the Lists settings reparent menu. All of them mint through one method,
`useListMutations().createTopLevel(name)` — in `web-react` and `expo-react`
beside the other list writes, not beside `ListCommand`: it is a write policy,
and the picker file is a component. It takes only a name and reads the root
group from the store when called, the way `findOrCreate` does, so a host that
binds it holds **no live list read** — the only one on these surfaces is
`ListCommand`'s own.

- **Why inline, rather than a "Manage lists" link out to Settings → Lists** (the
  shape the sidebar's `FooterLink` uses): the sidebar holds no draft, and every
  editor does. Navigating away destroys it — web quick-add would drop the
  very URL/note its `optionalDirty` guard exists to protect (invariant 3), and the
  extension popup would be killed outright by `tabs.create`, since a popup
  dismisses on focus loss uninterceptably. "Add a list" is a **sub-task of the
  save**; anything that ends the save to do it isn't an answer.
- **"Move to" creates inline for the same reason, with a selection standing in
  for the draft.** Navigating to another view exits bulk-edit mode (§_bulk
  edit_), so making the destination in Settings → Lists drops the selection the
  user came to file — and a bulk move has no other route to a new list. The
  single-link move always had one (Edit → the list picker → Create → Save), which
  is the argument for the Create row there too: withholding it prevented nothing
  and only lengthened the path. This reverses an earlier rule — "a Create row
  inside a _destination_ picker is a different intent wearing the same clothes" —
  that named no failure it prevented; filing a link into a list that doesn't
  exist yet is one intent, whether the link is new or not. **Confirming the name
  is the whole move**: the list is created and the links land in it in one
  gesture, and a row pressed while the create is landing can't start a second
  move. That refusal lives in `ListCommand`, on both platforms, because it is the
  only layer that can see the create in flight and every creating host follows
  the create with a write of its own — without it the row menu's submenu moved
  the link to the picked list and then again into the new one, and the native
  dialog reported two destinations, the second of which the bulk bar drops while
  the first move is running, leaving the new list empty. `LinkMoveSurface` holds
  its own `busy` span on top, which also covers the move. Two things differ from
  an editor, in opposite directions. There is **no Save in between**, so a
  mistyped name is a list created _and_ links filed in it — both recoverable
  (move again; the list deletes once it's empty), neither undoable in place. And
  nothing is **left behind empty**: an editor that creates and is then cancelled
  orphans a list (below), while here the create only ever happens as part of a
  move.
- **Every create lands in the same place: top-level, index 0.** `parentId: null`
  and the head of the root group — for **both** entities, on **every** surface: the
  settings `CreateRow`s, `ListSelect`'s Create row, the link "Move to" surfaces'
  Create row, `useTagMutations.findOrCreate`, and the share sheet's two pickers.
  For lists the in-app surfaces don't each restate it: the Lists settings
  `CreateRow`, `ListSelect` and the "Move to" surfaces all call
  `useListMutations().createTopLevel`, which owns the position. One action, one
  landing spot, wherever it's invoked; there is no per-entity or per-surface
  variation to remember. Two halves to the rule, each load-bearing for a
  different reason:
  - **Top-level is what keeps the create cheap despite the lists/tags asymmetry.**
    `findOrCreate(name)` takes only a name because a tag **is** its name;
    `useListMutations.create(name, parentId, siblings, index)` needs a **position in
    a tree**. The editors decline to ask — `createTopLevel(name)` fills the
    position in, from the store's root group as `buildTree` renders it (a list
    whose parent is gone sits at the root too, and can be the head to land
    before): nesting is non-destructive to defer
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
- **The name field keeps ArrowLeft from a dropdown submenu.** Radix closes a
  submenu on ArrowLeft from anywhere inside it, the filter box included, so
  stepping back through a half-typed name closed the row menu's wide "Move to"
  and discarded the name. That was reachable before — the box appears past
  `SEARCH_THRESHOLD` on any host — but a field whose job is typing a new name
  makes it the ordinary case. `CommandInput` stops the key at the input while
  there is a caret to move, and lets it through at position 0, where it is still
  the keyboard's way back to the parent menu. The guard sits in the shared field
  (`ui/command.tsx`) rather than in `ListCommand`, so `TagsCommand` carries it
  too: no host of the tag picker is a submenu today, and nothing would flag the
  day one became so. It is ArrowLeft only — cmdk also takes Home and End from the
  field (first and last row), which costs a caret jump and not the typed name, so
  that is left as cmdk has it.
- **Two smaller consequences, both in `list-command`.** (1) The filter input is
  normally count-gated at `SEARCH_THRESHOLD` (scrolling beats a box), but
  `onCreate` **forces it on at any count** — it doubles as the Create row's name
  field, and without it a small account (i.e. most accounts) would have nothing to
  type into. (2) An exact case-insensitive name match **suppresses** the Create
  row. That's stricter than lists strictly require — name isn't a list's identity,
  so a second "Recipes" under a different parent is legitimate — but a Create row
  competing with an identical row right above it reads as a mistake far more often
  than as intent, and the deliberate-duplicate case still has Settings → Lists.
  The match is against **every** list, not the rows the picker shows: all the
  creating pickers hide Trash, and checked against the visible rows a typed
  "Trash" was offered as a new list — on a "Move to" surface, a second Trash with
  the link already filed in it. Read off the unfiltered tree, the rule follows a
  renamed Trash and whatever a later picker excludes. The cost is "No lists
  found." under a name that does exist, which is accepted: nothing there can be
  picked, and trashing is Remove.

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

- **The row menu's "Move to"** (`_layouts/shared/link-row-menu.tsx`,
  `LinkRowMenu`) renders `ListCommand` **directly** — the same component
  `ListSelect` wraps. So a change to `list-command` (its props, its row shape, its
  `excludeIds`/`disabledIds` handling) hits the move-to menu too, not just the
  editors. It passes `excludeIds={[TRASH_ID]}` and `disabledIds={[link.listId]}` —
  trashing is the menu's Remove, never a "move", and the current list stays
  visible-but-disabled to keep the tree's shape intact. It **does** pass
  `onCreate` (§"the shared pickers", _"Move to" creates inline_), which also
  means the filter field is there at any list count. The create is wired inline
  in the menu: `LinkRowMenu` renders once per virtualized row, but
  `createTopLevel` holds no live read, so binding it per row costs what the link
  and pin mutations beside it already do. The read that matters is
  `ListCommand`'s live one, and it stays inside the submenu's content, which
  exists only while it is open — read the lists anywhere outside it and every
  row on screen holds a live query.
  **It has two shapes, split at `md`** (`view-state-provider`'s `wide`): the
  submenu above, and below it a plain item that hands the link to the page-level
  `LinkMoveSurface` — because the submenu doesn't fit a phone (see §"the shared
  pickers"). Same picker, same exclusions, same Create row, different box; the
  ellipsis on the narrow item ("Move to…") is the convention that it opens
  something further.
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
  select — same pattern as `LinkRowMenu`. It splits at `md` for the same reason
  and into the same two shapes as the row menu's, into a `MoveToSurface` the
  section hoists beside its `LockPasswordDialog`; both shapes call one `moveTo`,
  so the `nestedLists` paywall gate and the destination maths can't drift between
  them. The narrow path resolves its row against a **collapse-free** flatten, not
  the rendered one: a sync landing another device's reparent can slide the row
  under a collapsed ancestor, which would otherwise close the picker mid-pick.
  Drag-and-drop with depth projection is still the _primary_ reparent gesture
  there; this menu is the keyboard/mouse fallback. It must never pass `onCreate`
  — this picker chooses a **parent** for a list, and minting another list from
  inside it is incoherent. The section's own `CreateRow` is a row away.
- **The rule the two menus above share**: `list-command`'s optional props split
  its audiences, and no surface takes both. `root` is for **reparenting a list**
  (leave it out on link surfaces — a link always lands in some list); `onCreate`
  is for **filing a link** (leave it out on the reparent menu). Adding a consumer
  means deciding both, not copying the nearest call site — the two "Move to"
  menus look alike and pass opposite ones, and `MoveToSurface` passes both
  through without opinions precisely so each caller keeps making that call.
- **The row menu's "Edit note"** is the reason the edit dialog takes a
  `focus?: 'tags' | 'note'` (`LinkEditRequest` in `view-state-provider`) rather
  than the boolean it started as. **The note has no read-only surface** — reading
  it IS opening the editor on that field, which is why the item routes to
  `openEditor(link, 'note')` exactly as "Edit tags" routes to `'tags'`. That's a
  deliberate no: a separate note dialog would need its own page-level hoisting
  and `engaged` handling (rows are virtualized and repaint under sync — see
  invariant 4), and at `LINK_NOTE_MAX` a `Textarea` reads as well as a viewer
  would, with the edit already in hand. A new "land focused on X" entry point
  should widen this union, not grow a surface.
- **That item is always on, and sits directly below "Edit tags".** It read
  "View note" and rendered only when `link.note` was set, on the argument that
  adding one is plain **Edit** so an always-on item would duplicate it — but
  that argument doesn't survive its own sibling: "Edit tags" is always on and
  duplicates **Edit** in exactly the same way, earning its place as a
  _field-focused shortcut_, not as the only path. Three things followed from the
  conditional and are the reason not to restore it: the label described the
  intent rather than the destination (which is an editable `Textarea` with
  Save/Cancel, never a viewer); the menu had two shapes, so **Edit** was the 2nd
  item on a noteless row and the 3rd on a noted one and everything below shifted
  with the data; and adding a note meant **Edit** → past list and tags to the
  fourth field (past the image preview too, back when that sat second). The presence of a note is still signalled — that is
  `NoteBadge`'s job on the row (next bullet), not the menu's. Both are absent
  from the Trash variant, like the other edit affordances.
- On bracemark-expo the same items push `/edit-link` with the same `focus` union
  as a route param — with one native divergence: `focus` **scrolls** the field
  into view instead of focusing it, because focusing a native input summons the
  keyboard over the very note most opens are there to read (web's `focus()` has
  no such side effect). The rename doesn't change that: an always-on item is
  reached with a note to read more often than with one to write.
- **The layouts show the note as a badge, never inline.** Every link item on both
  platforms measures its own height now (no layout budgets one — see
  [client-queries.md](./client-queries.md)), so this is no longer arithmetic: it
  is density. A note line would render on every noted item and push a two-line
  title plus host plus chips past what a dense row can carry, and on a card it
  would come between the title and the tags on the majority of cards that have no
  note to show. So each item renders `NoteBadge` beside `PinnedBadge` — card and
  list alike — carrying the text in `title` for hover, with "Edit note" in the
  menu as the real read path. This is a deliberate trade against `note`'s own
  rationale in `entities.ts`, which caps the field (`LINK_NOTE_MAX`) precisely so
  it CAN be shown in a list view; the density won. If that's ever revisited, the
  card layout is where the line fits — it has the most room per link and it grows
  to whatever it renders. Either way the field must stay inline on the link: were
  it to move to a `files/` blob (the deferred `noteId`), the layouts would lose
  the cheap read that makes even the badge possible — and so would the search
  grammar's `note` clause ("Note contains" in the Plus editor,
  [search.md](./search.md)), which filters on the same inline field with no join.
  That clause is also the answer to what the badge costs: a note you cannot read at
  a glance is at least one you can find. The badge **lights** while such a search is
  running (`hasPositiveNoteClause`, `@stxapps/shared` — muted → full ink, with the
  accessible label moving too), which is the other half of that answer: a `note` hit is
  the only match the row can't otherwise explain, since the title and host are both
  on it. See [search.md](./search.md).
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
starts fresh from the link. Web quick-add resets its fields on
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

**3. Guard the close so a stray click can't lose work.** The edit dialog and web
quick-add both compute a `dirty` flag that mirrors the patch Save would write
(`isDirty` in the dialog, `optionalDirty` in quick-add), and **swallow only the
accidental close vectors** — backdrop click / overlay tap, Escape, hardware back
— while dirty. Note the dirty check is the _same_ field-by-field comparison the
patch builder uses, so "dirty" means exactly "Save would write something" — an
untouched Save is a no-op that never bumps `updatedAt` (which would reorder the
date-modified sort). The extension's popup editor has **no** close guard: a
browser popup's close is the platform's (it dismisses on focus loss, not
interceptable), and it's create-only, so there's less to lose — don't assume the
invariant holds there.

**The corner X is a DELIBERATE door, not an accidental vector** — it belongs with
Cancel, on the far side of the guard. Both call the unguarded close directly, so a
deliberate discard stays one click from either. The distinction is about what the
user aimed at: a backdrop click and an Escape are things that happen _to_ a form,
while a 32px control named Close is pressed on purpose, and someone who has read
the header and reached for the X has already decided. Guarding it bought nothing —
it did not save the work, it only made the button do nothing, with no lint error,
no failing test and nothing to announce the refusal to a screen reader. Anyone
whose eye went to the corner instead of the footer read the editor as **stuck**,
since Escape and the backdrop were dead too and Cancel was the one live exit.

Nothing about that was decided per surface: it is where the guard sits. Radix and
`@rn-primitives` both give a dialog **one** close callback, so a
`DialogPrimitive.Close` in the corner arrives at `onOpenChange` indistinguishable
from an Escape, and a guard written there catches all three. The two surfaces that
did not use a primitive's close had no such problem and always got this right —
web quick-add's sheet (its own X, `onOpenChange(false)`) and bracemark-expo's
link-edit-screen (its own header X, setting `closing` to drop
`usePreventRemove`). So `DialogContent` on both platforms, and web's
`SheetContent`, take an **`onClose`** prop: given one, the corner button stops
being a primitive `Close` and calls it directly, while Escape and the backdrop
keep routing through `onOpenChange` where the guard still wants them.
`showCloseButton={false}` still drops the button entirely. A guarded editor that
renders a corner X **must** pass `onClose`, or it ships the dead button again.

**4. Hoist the editor above the rows, and hold `engaged` while it is open.** Rows
are **virtualized and repaint under sync** — a touched link floats to the top of
the date-modified sort, and a row can move or unmount underneath whatever it
owns. So a row must never own its editor: the row menu and the bulk toolbar only
_request_ an edit, and the dialog is rendered **once at the page level** (Main),
driven by hoisted state in `view-state-provider` — `editing: LinkEditRequest |
null` for the edit dialog, `retagging` for BulkTagsDialog, `moving` for
LinkMoveSurface. A row-owned dialog would unmount mid-edit and take the draft
with it (invariant 1's snapshot is no help if the component holding it is gone).
The rule extends past editors to any surface a row can raise: `LinkMoveSurface`
is a picker, not an editor, and it is hoisted for exactly the same reason — plus
one it doesn't share, which is that **the write lives with the surface**, so its
two callers (a row menu below `md`, the bulk toolbar at every width) don't each
carry a copy of the move.

That same hoisted state **is** the engagement flag: `engaged` is
`scrolled || openMenus > 0 || editing !== null || destroying !== null ||
retagging !== null || moving !== null || bulkEditing`, and `useLinks` stages
incoming sync results
while it holds — `displayed` stays put and the refresh pill lights instead of the
list repainting under the modal ([client-queries.md](./client-queries.md), the
staged-snapshot rule). Row-anchored overlays that are not editors (the row menu,
the tag overflow popover) join the same count through `useEngagedOpen`, which
tracks its own open flag so an unmount-while-open — a layout switch across the
breakpoint — releases the count instead of pinning `engaged` true forever.

Two surfaces are exempt, for the same reason in different words: **web quick-add**
and the **extension popup** are create-only, so they are anchored to no row and
have nothing to be repainted out from under them (quick-add's `open` is therefore
plain local state, not hoisted). And the **bracemark-expo** editors get the
guarantee structurally — a modal-presented router screen lives outside the list's
tree, so there is no row to lose and nothing to hoist. A new editor over
_existing_ links on web inherits the rule.

**A failed write is silent in every one of these editors, and that is a decision
rather than an oversight.** Every save handler is `try { … } finally {
setSaving(false) }` with no `catch` — the edit dialog, quick-add, the move
surface, the destroy confirm, `BulkTagsDialog`, and both bulk bars' `runBulk`, on
both platforms. A rejection out of `update`/`updateMany`/`destroy` therefore
escapes the handler (a console error on web, a LogBox warning in bracemark-expo's
dev build) and the user is told nothing in words. What the user gets instead is
the state the code falls into, and it is the recoverable one: the write is a
single transaction, so nothing landed; `onClose()` and `exitBulkEdit()` sit
_after_ the await, so the editor stays open with the draft intact and the
selection unchanged; `finally` re-arms Save. Pressing it again is the whole
affordance. **No spec can pin that state**, on either platform: the escape is an
async handler whose promise nothing awaits, and jest-circus fails any test that
produces an unhandled rejection — a spec-local
`process.on('unhandledRejection')` never fires, because jest listens on the real
process while the sandbox's `process` is a deep copy of it. So the recovery
described here is checked by hand, not by the suite
([testing.md](./testing.md), _coverage today_). What could reach that catch is a
**local-store** write failing — a
Dexie or expo-sqlite transaction, so a quota or a closed database — which is
neither about a value in the form nor a decision the user can make: there is
nothing to put in a footer but OK, nothing to say beyond "it didn't save", and a
dialog that said it would still have to leave the draft exactly where the silence
already leaves it. Sync failures don't reach here at all; the write is local and
`requestSync()` is fire-and-forget
([local-first-sync.md](./local-first-sync.md)). `bulk-edit-toolbar.tsx`'s
clipboard `catch` records the same conclusion for its own row.

**The two things that DO report mark the boundary.** Validation is not this case:
an empty URL is about the value in the field, it blocks before any write, and it
gets its `role="alert"` line in all four create surfaces (invariant 2). And the
lists/tags tables' `useOpRunner` → `SettingsNotice` is scoped to those two tables
on purpose (_the editing surfaces_ above, the Delete entry) — they are a
different shape of surface, where ops run from rows a screen apart and a rename
commits on blur.

**So don't fit one editor with an error surface of its own.** A `catch` plus an
alert line in a single dialog makes that dialog the only link operation in either
app that reports a failure, and if it is bulk retag then the least consequential
op reports while the full edit dialog stays mute — an inconsistency the next
reader has to re-litigate from scratch, since nothing in the file says the
silence was chosen. If the silence should end, it ends for all of them at once
through one shared surface, and this entry changes with it.

### bulk edit

Bulk edit is a **mode**, not a separate editor: the topbar toggles `bulkEditing`
in `view-state-provider`, items grow a `LinkRowSelect` checkbox
(`_layouts/shared/link-row-widgets.tsx`) and hide their options menu, and the
`BulkEditToolbar` acts on the hoisted `selectedLinks` map (keyed by the stable
`link.path`).

- **Where the checkbox goes, per layout.** The list puts it in a leading-edge
  column — one per row at the same x, scannable straight down the pane. A card
  has no such column, and the meta line's trailing slot (the ⋯ menu's) buries a
  16px box among the favicon, host and badges, so the card floats it over the
  **banner's top-leading corner** instead: the same rule (the item's leading
  edge), and where a grid of previews has taught people to look. It sits at
  `size-6` on an opaque `bg-background` backing at the checkbox's own radius —
  the control unchecked is a 1px outline over a transparent middle, invisible on
  a light photo, and at the list's `size-4` a `rounded-[6px]` box is 37% radius,
  which fills into something closer to a disc than a checkbox. Neither needs a
  sized wrapper for the target: the checkbox carries its own hit expansion
  (`after:-inset-*` on web, `hitSlop` on expo). The vacated menu slot holds an `aria-hidden` spacer at the trigger's
  `size-8` — not the menu disabled, which would announce as a dimmed button and
  swallow the click that should select the card, and not nothing, since that
  line's height IS the trigger and the host would take the freed width and carry
  the badges right. Reserved and empty, the card measures the same in both modes.
  A **selected** card also takes an accent outline, because `bg-muted` alone
  barely reads under a banner that covers most of the card: the fill shows only
  in the text strip beneath it — between a third and a half of the card,
  depending on the column width and the title's line count — and that fill is
  10/255 in light. So `ring-1 ring-muted-foreground` on web (a box-shadow, so it
  costs no layout, and it paints outside the card, always against the page
  background rather than against the banner) and `border-muted-foreground` on the
  expo card's existing 1pt border. Same weight, different mechanism, and the
  difference is forced: a second point of border on expo would reflow the card,
  and RN has no ring — Uniwind appears to map `ring-1` but assembles it from
  `--tw-ring-*` vars that don't exist there, so it yields a broken box-shadow
  string rather than an error (`theme.md`, the class-mapping tripwire). Not `primary`: the palette is fully
  neutral (every token is chroma 0), so `--primary` is 0.205 in light — the
  foreground itself, which shouts. `--muted-foreground` at 0.54/0.78 is the step
  below it. Not `--ring` either, near as it looks: that token belongs to
  `focus-visible`, and reusing it would make a selected card and a keyboard-focused
  one the same picture.
- **The chip pill is an alpha toward the foreground, which is what spares it a
  selected variant.** A chip sits on an item, and an item has three surfaces:
  plain, hovered/pressed at `bg-muted/50`, and `bg-muted` while selected.
  `--secondary`, `--muted` and `--accent` are one grey in this palette, so a
  wash-token pill stepped 10/255 off a plain light row, 5 off a hovered one and
  **0** off a selected one — the strip gone outright at the moment the user is
  picking links by hand, with nothing to fail. `bg-foreground/6` (hover/press
  `/12`) diverges from all three by construction, every item surface in both
  themes sitting on the foreground's opposite side: 15/14/14 of 255 across the
  three in light, 14/14/13 in dark, and the same again on `--popover` behind the
  "+N" chip. An opaque `color-mix` toward the foreground clears all three too,
  but unevenly — a fixed colour's step shrinks as the surface moves toward it,
  down to 9/255 on a selected dark row — and expo has no `color-mix`, so it would
  owe a `--color-*` token there plus an entry in the formatter shim
  (`theme.md`). Both chip components carry the one string and neither reads the
  selection. The label stays `text-foreground/70` on it: 6.6:1 at worst in light,
  6.8:1 in dark, where `--muted-foreground` would fail AA on the pill.
- **The favicon plates take the same fill, for the same reason.** Both of an
  item's quiet plates — the bare one beside the host line, and the one behind the
  favicon in an image-less row's 64×40 slot — were `bg-muted`, so on a selected
  item they vanished exactly as the pill had, the second leaving a 16px favicon
  marooned in an invisible rectangle. They now carry
  `bg-foreground/4 dark:bg-foreground/8` on both clients (`link-media.tsx`,
  `Favicon` and `PreviewFallbackIcon`). The mechanism is the pill's; the tone
  deliberately is not, and the alpha is per theme because one number serves
  neither. `/4` on a plain light row is the old muted plate exactly (245), where
  the pill's `/6` read too heavy; `/8` in dark puts the plate at 29 on a plain
  row, where `/6` (24) read too faint against the muted plate's 38. The plate
  therefore sits a step quieter than the chips in light and a step stronger in
  dark, as it did while it was `bg-muted`, and steps 9/255 off a selected row in
  light and 17 in dark. bracemark-extension's popup specimen keeps `bg-muted`
  on its slot: it sits on the popup and is never selected.

- **The whole item is the click target.** In the mode a click anywhere on a row
  or a card toggles that link's selection, and shift-click extends a range over
  the displayed order; the checkbox is the visible state plus a small dedicated
  target, not the only one. Each layout hangs that on the surface it has —
  `list-layout` on the row element itself, `card-layout` on its title anchor's
  full-card `after:inset-0` overlay — and everything interactive inside gives the
  click up rather than eating it: `LinkRowSelect` stops propagation (in the list
  the row is its ancestor, so an un-stopped click would toggle twice and land
  back where it started) and `LinkTagChips` renders inert spans under
  `pointer-events-none`, since a chip that toggled selection itself ignored
  `shiftKey` and left the gaps around the pills dead. The list row also takes
  `cursor-pointer` in the mode — `styles.css` gives the pointer to buttons and
  `[role=button]`, and a div with an onClick is neither, so the row would toggle
  while looking inert (the card's overlay is an `<a>`, so it already has it) — and
  both take `select-none`, since shift-click otherwise drags a text selection
  across the rows it ranges over. The row takes no `role`: `LinkRowSelect` is a
  real checkbox inside it, and a second one in the AT tree for one selection is
  worse than a pointer-only enhancement. Cmd/ctrl-click toggles too
  rather than opening a new tab — the anchors' `preventDefault` is unconditional;
  middle-click still opens, being `auxclick`. On bracemark-expo the item is one
  `Pressable` and RN's responder hands a touch to the innermost pressable, so the
  hit area comes free; its chip strip goes inert in the mode all the same, so the
  press lives in one place on both platforms (and the item, not the pill, shows
  the press). The selected item is filled `bg-muted` in all four layouts —
  the checkbox is the precise readout, the fill is what makes a selection
  scannable as a block.
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
  trashed links are included, and the only action that does NOT exit the mode —
  it consumes nothing, so the selection still describes the rows on screen, and
  a toolbar vanishing is not confirmation that an invisible clipboard write
  landed. Its button flips to a check + "Copied" for a beat; the glyph flips,
  not just the label, because the icon-only tier renders no label). In Trash: **Restore** (→ My List — the schema records no previous
  list, same as the row menu) and **Delete permanently** (irreversible →
  `requestDestroy` → `LinkDestroyConfirm`). Elsewhere: **Move to**
  (`requestMove` → `LinkMoveSurface` — no Trash target, no `root`, and the Create
  row that files the selection into a list made on the spot, per §"shared
  pickers"; the selection's single shared list, when there is one, shows
  checked-but-disabled), **Edit tags** (below),
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
- **A bulk action is ONE write, never a loop.** Every action rides
  `useLinkMutations`'s batched `updateMany(edits)` / `destroyMany(links)` — one
  Dexie/SQLite transaction, one pending-op batch, one `requestSync()`. Looping the
  single-link `update`/`destroy` is the shape this replaced, and it is quadratic in
  the wrong place: each iteration is its own transaction AND its own re-run of
  `readLinks` plus a full repaint of the virtualized list, so a twenty-link move
  trickled down the pane over about a second. The patch is **per link**
  (`LinkEdit`) rather than one patch for the batch, because the retag diff resolves
  against each link's own `tagIds`; the uniform actions just map one patch across
  their targets, and callers pass only the links that actually change (an
  `updatedAt` bump for no change reorders the date-modified sort). Batching also
  retires `destroy`'s content-before-entities ordering — one transaction can't be
  interrupted halfway, so the sweep is a flat set of paths. **Pin/unpin are the
  deliberate exception**: `pin()` inserts each link at the TOP of the pinned
  section, so the sequence IS the resulting order (hence the reversed list), and
  there is no batched spelling of that. Same rule and same code shape on
  bracemark-expo.
- **Bulk Edit tags** (`BulkTagsDialog` — hoisted at the page level like the edit
  dialog, driven by `retagging` in `view-state-provider`) seeds one `TagsCommand`
  with the **intersection** of the selection's tags and saves the **diff**:
  added tags are added to every link, removed seed tags are removed from every
  link, and a tag only some links carry never starts selected and is never
  touched — a bulk edit can't strip tags the user couldn't see. An
  all-identical-tags selection degenerates to plain edit-in-place. It upholds
  the §invariants (copy-to-draft, dirty close guard, minimal per-link patches).

**On bracemark-expo** the mode is ported with the same selection/action semantics
(`features/links/` — `view-state-provider` holds the selection and the hoisted
`retagging`/`destroying` requests; `useLinkMutations`/`usePinMutations` live in
`@stxapps/expo-react`), with phone-shaped chrome: entry is the ⋯ menu's
"Select links" (no topbar slot), the toolbar is the **bottom-anchored**
`BulkEditBar` rendered by Main (✕ / count / Select all in its top row, actions
below; Android back exits the mode), the secondary actions sit behind a ⋯ menu
at every width (web's `COLLAPSE_WIDTH` split, fixed — a phone is always below
it, as it is below web's icon-only `ICON_WIDTH` tier), Copy keeps both its web
semantics (no mode exit, a check + "Copied" flash) but flips its glyph for its
own reason — the bar always renders the label, so the flip is there to match the
confirmation native's `ShowOnceSecret` already uses, Move to is a dialog embedding the native `ListCommand` cousin instead of
the anchored submenu (`features/links/move-to-dialog.tsx`, shared with the row
menu — same `excludeIds`/`disabledIds` wiring, the same Create row and no
`root`; the dialog reports a created list through the one `onSelect` a picked
row uses, so both hosts move into it with the code they already had. The create
is wired on the dialog's HOST side, not in its content, and has to be: the
content portals into the root `PortalHost`, above the `(app)` layout's
`SyncProvider`, and `useListMutations` reads `useSync` — from inside the content
it throws the moment the dialog opens, with every jest spec green because the
package is mocked at the barrel. The host side holds no live read for it
(`createTopLevel` reads the store when called), and the row menu mounts the
dialog only while open besides. The Lists settings
reparent dialog embeds the same body with `root` and no `onCreate`, like web).
**Web
converged on the same shape below `md`** (`MoveToSurface`) once its submenu was
measured against a phone — but it converged on the _picker_, not the container:
expo keeps a dialog at every width (a phone is the only width it has, and Dialog
is already the idiom for every picker it renders), while web forks to a bottom
sheet, which is its own narrow-width language. Don't port the container in either
direction; expo has no sheet primitive, and buying one is a native dependency
decision ([architecture.md](./architecture.md), _dependency versions_) — and the
one that looks free, a `formSheet` route presentation, is NOT the answer for a
surface with a keyboard: it has no Android half and it forbids the scroller the
keyboard rules are built on ([soft-keyboard.md](./soft-keyboard.md), _the add
panel_, carries all three measurements). The quick-add is a bottom panel its own
screen draws instead (`links/link-add-panel.tsx` over `links/index.tsx`), which
is the shape web's narrow layout already uses — so the two clients agree on the
container as well as the form. **The expo EDITOR stays a modal route**: it is a
full-height form with nothing to reclaim, and a presented route is what gives it
swipe-down, back and `usePreventRemove`. A growable picker that outgrows a dialog
still has no sheet primitive to reach for; the panel is a one-caller shape, not a
component, until a second surface needs it.
What a dialog does NOT get for free is the keyboard, or the room the keyboard
leaves: portaled content inherits nothing from the screen's scroll container, so
`ui/dialog.tsx` carries its own avoider and bounds itself to what is left, and a
picker whose body can grow pairs that with `shrink` on its own scroller — which
is why the bulk tags editor stays a dialog rather than becoming a route screen
([soft-keyboard.md](./soft-keyboard.md), _avoidance_). And the
bulk tags dialog renders the picker body the in-app editors' `TagsField` opens
(`TagsCommand`) directly — filter input and reuse-or-mint Create included; the
single-link case no longer rides this dialog anyway — the row
menu's Edit tags pushes `/edit-link` focused on tags, like web). Web's
shift-click `selectRange` has no touch analogue and is not ported.

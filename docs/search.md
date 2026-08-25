## links search

How the links page turns a URL into a filtered, ordered view — the **write/route
layer** of search. This doc owns the `URL ⇄ LinkQuery` grammar, the two writers
(`setSimpleQuery` / `setQuery`), and why `selection` is a derived projection of the
query. It deliberately does **not** re-document two things that already have homes:
how a query is **evaluated** against the store (drivers, the extraction join,
non-exact totals) lives in [client-queries.md](./client-queries.md) — the read edge;
and **which rungs cost money** (basic free, advanced Plus, saved Pro) is data in
`packages/shared/src/iap/plans.ts`. This doc is the connective tissue between them.

Code: `app/(app)/links/_contexts/page-provider.tsx` (the grammar + writers +
projection), `app/(app)/links/_components/search-bar.tsx` (the UI), and
`packages/web-react/src/data/queries.ts` (`LinkQuery`, the read engine). The
native port (bracemark-expo) is `features/links/page-provider.tsx` +
`features/links/search-bar.tsx` — see _on native_ below. Getting back to a view
after a trip through Settings is `lib/links-return.ts` (web) and
`features/settings/close.ts` (expo) — see _leaving the page and coming back_.

### the query is the URL

The **URL is the single source of truth**. Both the full filter (`query: LinkQuery`)
and the single-axis view state (`selection`) are **derived** from it — never stored
separately — so search survives reload, the back button steps through views, and
every view is deep-linkable. The param value is always an **opaque id** (a system
constant or a random entity token) or a plain search word; never a plaintext list/tag
name, which stays encrypted in the local store. That's what keeps the URL
zero-knowledge.

`parseLinkQuery` maps the URL onto the grammar. Each filterable field carries its
relation in the param **name**:

```
list / list-any / list-none            (a link is in one list: no `all`)
tag  / tag-any  / tag-all  / tag-none
text / text-all / text-any / text-none (words over the COMBINED url⊕title)
url  / url-all  / url-any  / url-none   (substring words, url only)
title/ title-all/ title-any/ title-none
sort  = updatedAt | createdAt          (ordering field  — READ-ONLY override)
order = asc | desc                      (ordering dir    — READ-ONLY override)
```

- The **bare name is sugar** for the common relation: `list`/`tag` → `any` (include
  any of), `text`/`url`/`title` → `all` (must contain every word). Clauses **AND
  across fields** (a link must satisfy every non-empty one); cross-field OR is
  intentionally not expressible — see _deferred_ below.
- Values are **repeated keys** (`?tag=a&tag=b`, `?text=foo&text=bar`), never `+`
  (decodes to space) or comma (breaks on ids containing one). A multi-word search box
  therefore splits on whitespace into repeated keys, each an AND term.
- Two derivations bake into the parse: `?list=all` (`ALL_ID`) is **dropped** from the
  lists clause (Show All is the absence of a list filter, not a filter), and a URL
  with **no filter params at all** injects the default inbox (`lists.any =
[My List]`). This injection is load-bearing for the projection below.
- **`sort`/`order` are not filters.** Ordering is a **global synced setting**
  (`settings/general.enc` — Settings → Misc), and the URL params are only an
  **optional, hand-typed, read-only override** of it: present and known → they win;
  absent or unknown → the setting's value (the default the provider passes into
  `parseLinkQuery`). They're deliberately **out of the filter-key set**, so `?sort=…`
  alone still resolves to the default inbox rather than counting as a filter. And the
  setters (`hrefForSelection`/`hrefForQuery`) **don't serialize them back**, so a
  hand-typed sort is dropped on the next sidebar nav or committed search — making it
  survive interaction is the future per-view sort UI (serialize both builders, gated
  on ≠ the setting). The resolution lives in the provider, the one place the URL and
  the setting are both in scope; the read layer (`readLinks`) receives a concrete
  field+direction.

**`text` is the basic rung; `url`/`title` are the advanced rungs.** `text` matches
its words against the **combined `url ⊕ title` haystack** (host lives inside url), so
a word may land in either field — one clause, one box, "search words, all links".
`url`/`title` are the field-scoped counterparts. All three AND together and with
lists/tags like any other clause. How `text` is actually evaluated (it carries the
title half, so — like a `title` clause — it forces the link↔extraction join and drops
the exact count) is a read-engine concern: see
[client-queries.md](./client-queries.md) and `needsExtractionJoin` in `queries.ts`.

### two writers, not a mirror

The read direction is **many→one and lossy** (many URLs collapse onto one
`selection`), so it pays to derive `selection` once and let consumers read it. The
**write** direction is the opposite: nobody ever wants to "write a whole `LinkQuery`"
— the intents are small and specific. So there are two writers, shaped by intent, not
a single symmetric `setQuery`:

- **`setSimpleQuery(selection)`** — navigation. Commits a _simple_ query (one
  list/tag/all axis) as the **canonical clean URL** (`hrefForSelection`: `/links`,
  `?list=all`, `?tag=x`). The sidebar's writer — it shouldn't have to assemble a full
  `LinkQuery` with empty clauses just to say "list X". (Renamed from `setSelection`:
  it writes a _query_; `selection` is what you read back, never what you set.)
- **`setQuery(query)`** — the full grammar. Serializes an arbitrary `LinkQuery` back
  to the URL (`hrefForQuery`, the inverse of `parseLinkQuery` — bare relations for the
  common case, suffixed forms for the rest, repeated keys). The **search editor's**
  writer.

Both write the URL; both let `query`/`selection` re-derive from it. The asymmetry is
why there's no single wide `setQuery(LinkQuery)` for navigation: a full inverse
serializer is only justified once a writer needs the whole grammar, and the **advanced
search form is exactly that writer** — it builds text/url/title word clauses +
include/exclude lists + any/all/none tags and commits them. Before it existed, the
suffixed grammar forms were deep-link-only, so no serializer was warranted; the
advanced editor is what flips that.

### selection is a projection, never set

`selection` is a **lossy projection of `query` onto a single axis** — the one thing
the sidebar highlights and the topbar names — computed by `selectionFromQuery`, not by
a second read of the URL:

- a plain single list → `{ kind: 'list', id }`
- a plain single tag → `{ kind: 'tag', id }`
- no list/tag axis at all → `{ kind: 'all' }` (Show All)
- a text search, an exclusion, a tag-`all`, or any multi/compound filter →
  `{ kind: 'none' }` — **no highlight**, and the topbar titles it "Search".

Deriving off `query` (not the raw params) is what makes the highlight **honest**.
`query` carries the default-inbox injection, so bare `/links` resolves to `{ list:
My List }` (the inbox highlights), while a global search — which has a `text` clause —
resolves to `none` instead of a **stale list highlight**. Because `selection` is a
pure function of `query`, the two can never disagree: the sidebar can't claim you're
in "My List" while the pane shows global results.

The `none` arm is the null-object of the union: consumers already branch on
`selection.kind`, so most (`link-add-surface`, `bulk-edit-toolbar`, `main`'s lock
gate, the sidebar's ancestor-expand effect) simply do nothing for `none`, which is
correct — there's no list/tag context during a search. Only two needed an explicit
`none` branch: `isActive` (sidebar — a kind match is enough for `all`/`none`) and
`useSelectionLabel` (topbar — `none` → "Search"). `hrefForSelection('none')` →
`/links` (navigating "to nothing" = home).

### leaving the page and coming back

Settings is a **round trip**, and it used to be a one-way door: both clients' close
buttons navigated to a hard-coded `/links`, so going to Settings to add a list or
change the sort dropped whatever list, tag, or search you were on. The URL already
survives everything — this is not view state that needed persisting, it's a **return
destination** that was never recorded. Each client fixes it with the primitive its
own navigation gives it, and the two fixes look nothing alike on purpose.

**bracemark-expo pops.** `links` and `settings` are sibling cards in the `(app)`
stack, so the links screen stays **mounted** underneath while Settings covers it.
`features/settings/close.ts` (`closeSettings`, shared by the topbar's ✕ and the
drawer's back arrow) calls `router.dismiss()` — one card, so a Settings opened from
the add-link screen uncovers that instead — which reveals the original screen with
its params, its scroll offset, and its view state intact. The old `push('/links')`
built a _second_ links card at the default view and left the real one buried below it.
`canDismiss()` false means a cold entry (a deep link, or the paywall pushing
`/settings/subscription` first), and then it's a real `replace('/links')`. Moving
between sections doesn't stack: they're screens of the Settings drawer, so
expo-router demotes their `push` to a navigate.

**bracemark-web remembers.** Nothing stays mounted — navigating to `/settings` unmounts
the links tree — so the route itself has to be recorded. `LinksPageProvider` writes the
current href to `sessionStorage` on every URL change (`lib/links-return.ts` owns the key),
and the ✕ reads it on mount, defaulting to `/links`. **Session**, not local: this is
per-tab "where I was", not a preference — with `localStorage`, a second tab's ✕ would
jump to the first tab's filter and next week's visit would open on a stale tag. The
read happens in an effect because `sessionStorage` doesn't exist on the server, so the
first paint is the `/links` default on both sides and the stored href swaps in on mount
— no hydration mismatch, and the ✕ stays a real `<a href>`. A stored value is checked
to be `/links` or `/links?…` before use: it's user-writable storage feeding a link, the
same open-redirect hole `guest-guard.ts` closes on its `?next=` param.

**A returned-to view can be stale**, because Settings is exactly where lists and tags
get deleted. Both providers therefore carry `isStaleSelection`: a single-axis
`selection` whose entity is gone sends the page home (`replace`, so the vanished view
isn't a back destination). It runs on **positive evidence only** — `useLists`/`useTags`
collapse "still loading" into `[]`, so only a _non-empty_ tree can convict an id, which
is what keeps a cold load of a shared list URL from bouncing to the inbox. Lists always
land non-empty (the system three are merged in); the one case it can't judge is a tag id
on an account whose last tag was just deleted, which falls back to the "Unknown" header
it would have shown anyway. Compound queries are never judged — one dead id among live
clauses isn't worth discarding the whole search. The rule lives with the URL rather than
in the close button because a stale bookmark and a back-button entry reach the same
state, and on expo it is additionally **gated on focus**: the provider stays mounted
under Settings, and an ungated `replace` would swap Settings out from under the user
mid-edit.

### the three-rung ladder (tiering)

Search splits by **structure, not by whether you can search at all** — the same
Free → Plus → Pro spine as the rest of the app. Free gets real word search across the
whole library (`text`); Plus gets the **structured editor** (field-scoped url/title,
multi-list/multi-tag), gated by the `searchEditor` entitlement; Pro persists queries as
saved searches. The gate is **value-capture, client-enforced** — the editor costs
~nothing to serve, so a bypass only unlocks a convenience. The entitlement table:
`packages/shared/src/iap/plans.ts` (`searchEditor`).

### the UI

`SearchBar` (topbar) is a **basic box** plus an **advanced popover**:

- **Basic box** — persistent in the topbar from `md` up (the free daily-loop feature
  shouldn't sit behind a click), and **a row the topbar summons below it** on a
  narrow viewport, where a title plus four actions leave no room for a box. The
  same component fills both slots; the topbar owns the measure and the toggle.
  Visibility below `md` is the derived `searchVisible` in `view-state-provider`
  (`searchOpen || selection.kind === 'none'`), so the toggle and the row can't
  disagree, and dismissing the row also **restores the view the search was run
  from** (`preSearch`, falling back to the default inbox) — with the row gone, a
  committed `?text=` would otherwise keep filtering the list with nothing on
  screen left to show or clear it. This is the same shape bracemark-expo settled
  on; see _on native_ below, which now differs only in that a phone has no wide
  slot to fall back to. Type + Enter commits `?text=…`; results reshape the main
  pane. **Basic
  search is GLOBAL by design**: submitting replaces the whole query with just its text,
  so a search spans the library rather than the list you were on. An empty box returns
  home. (Sort isn't part of the committed query — it's the global setting resolved by
  the provider — so a search neither carries nor needs to preserve it.)
- **Advanced popover** — an anchored panel (not a modal: search is iterative, so the
  results stay visible while you refine). It exposes nearly the whole grammar:
  - the **word trio** over the combined url⊕title haystack — _All / Any / None of
    these words_ → `text.all` / `text.any` / `text.none` (the familiar
    Google-advanced-search shape; since the haystack contains the url, "None"
    also covers the practical exclude-a-domain case);
  - field-scoped **URL contains** / **Title contains** → `url.all` / `title.all`;
  - **tri-state list/tag checklists** — each row cycles include → exclude → off
    (`lists.any`/`lists.none`, tags likewise), with a **Match any/all** toggle on
    the included tags (`tags.any` vs `tags.all`, shown once ≥2 are included). A
    single included tag always commits as `any` — the same set either way, and
    `any` keeps the sidebar highlight and the clean `?tag=` URL where `all` would
    project `selection` to `none`.

  It submits the full query through the same `setQuery` and snapshots the
  committed query on open, so it edits the current query in place and
  **round-trips every clause it renders**. The only grammar forms it does _not_
  render are the field-scoped `url`/`title` `any`/`none` — deep-link-only on
  purpose: `text.any`/`text.none` subsume them in practice, and covering them
  would cost four more inputs for the tail of the tail. Committing from the
  editor drops those four if a hand-built deep link carried them (WYSIWYG: what
  the form shows is exactly what runs); likewise a deep link carrying _both_
  `tag-any` and `tag-all` collapses to `all` mode over their union on open. A dot
  on the trigger marks a committed query carrying filters beyond a single-axis
  selection.

  The additions land on the read engine's cheap paths: `tags.all` is index-driven
  like `tags.any` (the tag driver), list/tag excludes are column predicates (no
  blob decode), and `text.any`/`text.none` cost the same as `text.all` (any text
  clause already forces the extraction join) — see
  [client-queries.md](./client-queries.md).

- **The Plus gate lives in the form, not the write path.** Free users see the trigger
  (visible, not hidden) but opening it presents the upgrade path instead of the
  fields — so the query grammar and URL contract stay tier-agnostic (a Plus user's
  advanced deep link still _parses_ for a free user; they just can't _build_ one).

### on native (bracemark-expo)

The whole write/route layer above ports **verbatim** to
`features/links/page-provider.tsx` and `features/links/search-bar.tsx`: the same
`URL ⇄ LinkQuery` grammar, the same two writers, `selection` as the same lossy
projection, and the identical `Draft` / tri-state / `apply` logic. Same URL
params, so a link view **deep-links identically across web and native**. Only
the platform seams differ, and each is documented in those files' header
comments — not re-derived here:

- **The "URL" is expo-router route params**, not `URLSearchParams`. Repeated keys
  (`?tag=a&tag=b`) arrive as a `string[]` value, so an `all()` helper stands in
  for `getAll`; the params object is fresh each render, so the `query` memo keys
  on the serialized bag (`JSON.stringify`) and parses it back inside for an
  honest dep list, where web gets object identity from `useSearchParams`.
  Navigation is `router.push`; there is **no Suspense boundary** (route params
  have no prerender constraint).
- **Which params hook is a correctness question, not a style one, and it is
  `useGlobalSearchParams`.** The provider is rendered by the links _layout_ —
  it has to be, the drawer content and the screen need the same context — so it
  stands on the `links` route of the `(app)` stack, one level above the `index`
  route the query params land on. `useLocalSearchParams` resolves against the
  route that renders the caller, so there it returns the layout's own params,
  which are empty and STAY empty: a drawer pick or a committed search is a
  `push('/links?…')`, and expo-router aims it at the deepest navigator where the
  href and the current state diverge — the Drawer, where a push demotes to a
  navigate (the same demotion the settings sections rely on, above) that rewrites
  only that navigator's route. So the page parsed an empty bag on every
  navigation, which is the no-filter-keys default: every list, every tag and
  every search resolved to My List, with nothing for the read edge to re-run. Both
  hooks return a plausible bag and nothing lints the difference — the symptom is
  a screen that quietly never changes. The global hook reads the focused route
  chain off the navigation state instead, which is exactly those params. It is
  **held while another screen is focused** (gated on the focused _pathname_, not
  `useIsFocused`, whose event-fed state lags the params by the one render that
  would poison the held bag): "global" follows whatever is on top, and this
  provider stays mounted under Settings and under the modal editors, where
  swinging onto their params would parse the same My List default and throw away
  the view the user is coming back to — the round trip `closeSettings` exists to
  preserve. `features/links/page-provider.spec.tsx` pins all of it through a real
  routed tree, the only layer that can see any of it.
- **The basic box is a toggle-summoned full-width row at every width**, where web
  falls back to a persistent topbar box from `md` up — a phone topbar has no room
  for one, and a phone has no `md`. The mechanism is otherwise the same on both,
  and was settled here first: the Search action reveals a row below the bar
  (view-state-provider `searchOpen`), rendered visibility is the derived
  `searchVisible` (`searchOpen || selection.kind === 'none'`) so the topbar
  toggle and the bar itself can't disagree, the `none` disjunct force-shows the
  bar for a committed search that has no other on-screen surface (a back-gesture
  into a `?text=` URL), dismissing restores `preSearch`, and the row is mutually
  exclusive with the bulk-edit toolbar (same slot). Web ports the whole of that
  for its narrow widths, naming included.
- **The advanced editor is a full-height page-sheet `Modal`**, not an anchored
  popover — five inputs plus two checklists and a keyboard don't fit a 320px
  panel on a phone. The tri-state box is **hand-rolled** (check/minus), because
  the reusables `Checkbox` primitive is boolean-only where web leans on Radix's
  `indeterminate`.
- **The Plus gate closes the sheet under the paywall, then reopens on "Not
  now"** (draft preserved in component state), rather than web's keep-the-popover-
  open-behind: the paywall dialog portals to the root PortalHost, which Android
  draws _behind_ the Modal's native window. Same peak-intent trigger (pressing
  Search), same "let them build, then upgrade" shape.

### deferred, on purpose

Two capabilities are intentionally unbuilt — not missing, and additive when demand
shows. Documented so they aren't re-derived.

- **`match: 'all' | 'any'`** — a top-level toggle for **cross-field OR** ("in these
  lists **OR** with these tags"). The engine currently ANDs all clauses, i.e. an
  implicit `match: 'all'`. Within-field OR already works (`lists.any`, `tags.any`), and
  the common url-OR-title OR is handled by `text`'s combined haystack — so the only
  gap is the genuinely-rare cross-field union, the least-used and most-misread query
  shape. Add it as a one-field/one-param/one-branch/one-toggle increment (default
  `'all'`, URL-only, no migration) the first time a user asks. A full nested boolean
  AST stays out until grouped conditions are explicitly demanded.
- **Live / debounced search** — the basic box commits on Enter (a history `push`),
  not as-you-type. As-you-type filtering via `router.replace` (no history spam) is a
  refinement, deferred to keep the write path simple and shareable.

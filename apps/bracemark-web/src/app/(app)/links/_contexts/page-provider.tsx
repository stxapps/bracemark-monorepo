'use client';

// Shared chrome state for the links page: the active `selection` (which the
// sidebar sets, the topbar names, and the main pane filters by) and the derived
// `query` the main pane reads through.
//
// Both live in the URL (`?list=…` / `?tag=…`): it survives reload, the back
// button works, and it's deep-linkable. The param value is always an OPAQUE id —
// a system-list constant (`my-list`/`archive`/`trash`/`all`) or a user entity's
// random token — NEVER the plaintext list/tag name, which stays encrypted in the
// local store. That's what keeps the URL zero-knowledge. (The list/card/table
// layout used to live here as a localStorage preference; it moved to a real
// setting — see `useSettings` / Settings → Misc.)
//
// The provider supplies its OWN Suspense boundary (see LinksPageProvider below):
// useSearchParams() opts the subtree out of static prerendering, which Next
// requires a Suspense boundary above. Owning it here — rather than at every call
// site — means consumers just render <LinksPageProvider> and the constraint
// travels with it (the self-wrapping AuthGuard/GuestGuard pattern).

import { createContext, Suspense, useCallback, useContext, useMemo } from 'react';
import { type ReadonlyURLSearchParams, useRouter, useSearchParams } from 'next/navigation';

import {
  ALL_ID,
  coerceLinkSortOn,
  coerceLinkSortOrder,
  DEFAULT_LIST_ID,
  LINK_SORT_ONS,
  LINK_SORT_ORDERS,
  type LinkSortOn,
  type LinkSortOrder,
} from '@stxapps/shared';
import { type LinkQuery, useSettings } from '@stxapps/web-react';

// The single-axis view the sidebar highlights and the topbar names — a lossy
// PROJECTION of `query` onto one axis (via `selectionFromQuery`; never set
// directly). `all` is the unfiltered Show-All view; `list`/`tag` carry the selected
// entity's bare id (the same id a link stores in `link.listId` / `link.tagIds`);
// `none` is "no single-axis highlight" — a text search or a compound/multi filter
// the sidebar can't point at one row for (so nothing is highlighted).
export type Selection =
  { kind: 'all' } | { kind: 'none' } | { kind: 'list'; id: string } | { kind: 'tag'; id: string };

// The canonical URL for a selection. The default (My List) is the bare `/links`,
// so the page's home carries no query noise; everything else is one opaque id.
// `tag`/user-list ids are random tokens, so encode them; the system ids are
// URL-safe literals but encoding is harmless and keeps the builder uniform.
function hrefForSelection(selection: Selection): string {
  if (selection.kind === 'all') return `/links?list=${ALL_ID}`;
  if (selection.kind === 'none') return '/links'; // no target axis → home (default inbox)
  if (selection.kind === 'tag') return `/links?tag=${encodeURIComponent(selection.id)}`;
  if (selection.id === DEFAULT_LIST_ID) return '/links';
  return `/links?list=${encodeURIComponent(selection.id)}`;
}

// The inverse of `parseLinkQuery`: serialize a full `LinkQuery` back to the canonical
// URL the search editor commits (`setQuery`). Emits the bare relation for the common
// case (`list`/`tag` → `any`, `text`/`url`/`title` → `all`) and the suffixed forms for
// the rest, as REPEATED keys — the exact grammar `parseLinkQuery` reads back, so the
// URL round-trips. Word arrays are re-lowercased/trimmed by `words()` on read, so we
// serialize them as-is. An empty query collapses to `/links` (which parseLinkQuery
// then reads as the default inbox — an emptied search returns home).
function hrefForQuery(query: LinkQuery): string {
  const params = new URLSearchParams();
  const append = (key: string, values: readonly string[]) => {
    for (const value of values) params.append(key, value);
  };

  append('list', query.lists.any); // bare `list` = list-any
  append('list-none', query.lists.none);
  append('tag', query.tags.any); // bare `tag` = tag-any
  append('tag-all', query.tags.all);
  append('tag-none', query.tags.none);
  for (const [field, clause] of [
    ['text', query.text],
    ['url', query.url],
    ['title', query.title],
  ] as const) {
    append(field, clause.all); // bare `text`/`url`/`title` = *-all
    append(`${field}-any`, clause.any);
    append(`${field}-none`, clause.none);
  }
  // Sort is deliberately NOT serialized back: the URL `?sort`/`?order` params are a
  // READ-ONLY (hand-typed) override of the global synced default (parseLinkQuery
  // below), so the setters emit clean URLs that fall back to the setting. A committed
  // search or a sidebar nav therefore drops a hand-typed sort — making it survive
  // interaction is the future per-view feature (serialize here, gated on ≠ default).

  const qs = params.toString();
  return qs ? `/links?${qs}` : '/links';
}

// The URL → `LinkQuery` grammar (data layer owns `LinkQuery`; this maps the URL
// onto it). Each filterable field carries a relation in its param NAME:
//   list / list-any / list-none           (a link is in one list: no `all`)
//   tag  / tag-any  / tag-all  / tag-none
//   text / text-all / text-any / text-none (words over the combined url⊕title)
//   url  / url-all  / url-any  / url-none  (substring words, url only)
//   title/ title-all/ title-any/ title-none
//   sort  = updatedAt | createdAt          (ordering field — READ-ONLY override)
//   order = asc | desc                      (ordering direction — READ-ONLY override)
// `sort`/`order` are an OPTIONAL override of the global synced sort setting: present
// (hand-typed) → they win; absent/unknown → the setting's value (the default the
// provider passes in). They're NOT filters (not in FILTER_KEYS), so `?sort=…` alone
// still resolves to the default inbox, and the setters don't serialize them back.
// The bare name is sugar for the common relation: `list`/`tag` → `any` (include),
// `text`/`url`/`title` → `all` (must contain every word). Clauses AND across fields.
// Values are REPEATED keys (`?tag=a&tag=b` / `?text=foo&text=bar`), never `+`
// (decodes to space) or comma (breaks on ids containing one). `setSimpleQuery`
// emits only the bare `list`/`tag` forms; `setQuery` (the search editor) emits the
// suffixed forms, which hand-built advanced deep links already relied on.
const FILTER_KEYS = [
  'list',
  'list-any',
  'list-none',
  'tag',
  'tag-any',
  'tag-all',
  'tag-none',
  'text',
  'text-all',
  'text-any',
  'text-none',
  'url',
  'url-all',
  'url-any',
  'url-none',
  'title',
  'title-all',
  'title-any',
  'title-none',
];

// Words are matched case-insensitively and trimmed; lowercase them here so the
// data layer can compare directly.
function words(raw: string[]): string[] {
  return raw.map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0);
}

// The URL sort override, or `undefined` when the param is absent OR holds a value
// this build doesn't know — either way the caller falls back to the setting default.
// Values are the exact enum literals (no friendly-name map); hand-typed only.
function sortOnParam(searchParams: ReadonlyURLSearchParams): LinkSortOn | undefined {
  const value = searchParams.get('sort');
  return LINK_SORT_ONS.includes(value as LinkSortOn) ? (value as LinkSortOn) : undefined;
}

function sortOrderParam(searchParams: ReadonlyURLSearchParams): LinkSortOrder | undefined {
  const value = searchParams.get('order');
  return LINK_SORT_ORDERS.includes(value as LinkSortOrder) ? (value as LinkSortOrder) : undefined;
}

// `sortOn`/`sortOrder` are passed in ALREADY RESOLVED (URL override ?? setting
// default — the provider computes them), so this just stamps them onto the query.
function parseLinkQuery(
  searchParams: ReadonlyURLSearchParams,
  sortOn: LinkSortOn,
  sortOrder: LinkSortOrder,
): LinkQuery {
  const query: LinkQuery = {
    lists: {
      // `all` is the show-everything pseudo-list, not a real filter — drop it.
      any: [...searchParams.getAll('list'), ...searchParams.getAll('list-any')].filter(
        (id) => id !== ALL_ID,
      ),
      none: searchParams.getAll('list-none'),
    },
    tags: {
      any: [...searchParams.getAll('tag'), ...searchParams.getAll('tag-any')],
      all: searchParams.getAll('tag-all'),
      none: searchParams.getAll('tag-none'),
    },
    // Basic search: `text` (bare) → `all` sugar, matched over the combined url⊕title.
    text: {
      all: words([...searchParams.getAll('text'), ...searchParams.getAll('text-all')]),
      any: words(searchParams.getAll('text-any')),
      none: words(searchParams.getAll('text-none')),
    },
    url: {
      all: words([...searchParams.getAll('url'), ...searchParams.getAll('url-all')]),
      any: words(searchParams.getAll('url-any')),
      none: words(searchParams.getAll('url-none')),
    },
    title: {
      all: words([...searchParams.getAll('title'), ...searchParams.getAll('title-all')]),
      any: words(searchParams.getAll('title-any')),
      none: words(searchParams.getAll('title-none')),
    },
    // Ordering: the already-resolved URL-override-or-setting sort (see the header).
    sortOn,
    sortOrder,
  };

  // No filter params at all → the default inbox (My List). `?list=all` IS a param
  // (the show-all view), so it doesn't trigger the default — it leaves the lists
  // clause empty after the ALL_ID drop above, i.e. no filter.
  if (!FILTER_KEYS.some((key) => searchParams.has(key))) {
    query.lists.any = [DEFAULT_LIST_ID];
  }
  return query;
}

// Project a `LinkQuery` onto the single-axis `Selection` the sidebar/topbar read —
// the inverse view of the same URL. Only a PLAIN single-axis query maps to a
// highlight; a text search or any compound/multi filter is `none` (no row to point
// at). Deriving off `query` (not the raw params) is what makes this honest: `query`
// carries the default-inbox injection (bare `/links` → `lists.any = [My List]`), so
// the default view highlights My List, while a global search — which has a text
// clause — resolves to `none` instead of a stale list highlight.
function selectionFromQuery(q: LinkQuery): Selection {
  // Any substring-text predicate (basic `text`, or field-scoped url/title) → search.
  const textTerms =
    q.text.all.length +
    q.text.any.length +
    q.text.none.length +
    q.url.all.length +
    q.url.any.length +
    q.url.none.length +
    q.title.all.length +
    q.title.any.length +
    q.title.none.length;
  if (textTerms > 0) return { kind: 'none' };

  // Exclusions or tag-`all` are compound filters with no single highlight.
  if (q.lists.none.length > 0 || q.tags.all.length > 0 || q.tags.none.length > 0) {
    return { kind: 'none' };
  }

  const lists = q.lists.any.length;
  const tags = q.tags.any.length;
  if (lists === 1 && tags === 0) return { kind: 'list', id: q.lists.any[0] };
  if (lists === 0 && tags === 1) return { kind: 'tag', id: q.tags.any[0] };
  if (lists === 0 && tags === 0) return { kind: 'all' }; // Show All
  return { kind: 'none' }; // multi-list, list+tag combo, etc.
}

interface LinksPageContextValue {
  // The single-axis sidebar/topbar view state (what's highlighted / named).
  selection: Selection;
  // Navigation: commit a SIMPLE query — one list/tag/all axis — as the canonical
  // clean URL (the sidebar). Named for what it writes (a query), not for the
  // derived `selection` you read back: selection is a projection, never set directly.
  setSimpleQuery: (selection: Selection) => void;
  // Commit an ARBITRARY query — the whole grammar (text/url/title words, multi
  // list/tag, none) — as the URL (the search editor). Both setters write the URL,
  // the single source of truth, and let `query`/`selection` re-derive from it.
  setQuery: (query: LinkQuery) => void;
  // The full filter the main pane reads through (`readLinks`). Derived from the
  // same URL as `selection`, but expresses the whole grammar (and/or/none across
  // lists, tags, and text/url/title words), not just the single selected axis.
  query: LinkQuery;
}

const LinksPageContext = createContext<LinksPageContextValue | null>(null);

function InnerLinksPageProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Sort is a GLOBAL synced setting with an optional READ-ONLY URL override: the
  // hand-typed `?sort`/`?order` win, else the synced value (coerced from its tolerant
  // `string` shape). Resolved here — the one place both the URL and the setting are
  // visible — then stamped onto the query, so use-links needs no sort logic.
  const { sortOn: settingSortOn, sortOrder: settingSortOrder } = useSettings();
  const sortOn = sortOnParam(searchParams) ?? coerceLinkSortOn(settingSortOn);
  const sortOrder = sortOrderParam(searchParams) ?? coerceLinkSortOrder(settingSortOrder);

  // The main pane's full filter — same URL, the whole grammar. Memoized on the
  // params + the resolved sort so its identity is stable across renders (it's a
  // useLiveQuery dep in useLinks); a new object only when the URL or the applied
  // sort actually changes. Depending on the RESOLVED sort (not the raw setting)
  // means a setting change while a URL override is active doesn't churn the query.
  const query = useMemo<LinkQuery>(
    () => parseLinkQuery(searchParams, sortOn, sortOrder),
    [searchParams, sortOn, sortOrder],
  );

  // Selection is a derived PROJECTION of the query — not a separate read of the URL
  // — so it can never disagree with what the main pane shows: a global search
  // resolves to `none` (no highlight), not a stale list. See selectionFromQuery.
  const selection = useMemo<Selection>(() => selectionFromQuery(query), [query]);

  // push (not replace) so the back button steps through the views you visited —
  // the deep-link/history behavior the URL approach is for.
  const setSimpleQuery = useCallback(
    (next: Selection) => router.push(hrefForSelection(next)),
    [router],
  );
  const setQuery = useCallback((next: LinkQuery) => router.push(hrefForQuery(next)), [router]);

  const value = useMemo(
    () => ({ selection, setSimpleQuery, setQuery, query }),
    [selection, setSimpleQuery, setQuery, query],
  );

  return <LinksPageContext.Provider value={value}>{children}</LinksPageContext.Provider>;
}

// The boundary the header comment describes: useSearchParams() (in the inner
// component) can't be statically prerendered, so it must sit under Suspense. The
// null fallback renders nothing until the params resolve — matching the gates
// above it in the (app) layout, so there's no flash.
export function LinksPageProvider({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={null}>
      <InnerLinksPageProvider>{children}</InnerLinksPageProvider>
    </Suspense>
  );
}

export function useLinksPage(): LinksPageContextValue {
  const value = useContext(LinksPageContext);
  if (!value) {
    throw new Error('useLinksPage must be used within a LinksPageProvider');
  }
  return value;
}

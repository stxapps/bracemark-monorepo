// Shared chrome state for the links screen — the expo port of bracemark-web's
// `(app)/links/_contexts/page-provider.tsx` (that file is the canonical doc for
// the grammar and the design: why selection is a derived PROJECTION of the
// query, why the URL params carry only opaque ids, the sort's
// URL-override-??-setting resolution). Divergences here:
//
//  - The "URL" is expo-router's route params (`/links?list=…`), read with
//    useLocalSearchParams — same params, same grammar, so a link view deep-links
//    identically across web and native. Repeated keys (`?tag=a&tag=b`) arrive as
//    a string[] value instead of URLSearchParams.getAll, hence `all()` below.
//  - Navigation is expo-router's router.push (the back gesture steps through
//    visited views, like web's history).
//  - No Suspense boundary: useLocalSearchParams has no prerender constraint.
//
// Lives in `src/features/links/` (not under `src/app/`) per the thin-routes
// convention — every file under the app root becomes a route.

import { createContext, useCallback, useContext, useMemo } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { useSettings } from '@stxapps/expo-react';
import {
  ALL_ID,
  coerceLinkSortOn,
  coerceLinkSortOrder,
  DEFAULT_LIST_ID,
  LINK_SORT_ONS,
  LINK_SORT_ORDERS,
  type LinkQuery,
  type LinkSortOn,
  type LinkSortOrder,
} from '@stxapps/shared';

// The single-axis view the sidebar highlights and the topbar names — web's
// `Selection`, verbatim (a lossy projection of `query`; never set directly).
export type Selection =
  { kind: 'all' } | { kind: 'none' } | { kind: 'list'; id: string } | { kind: 'tag'; id: string };

// expo-router's param bag: a repeated key is a string[], a single one a string.
type SearchParams = Record<string, string | string[] | undefined>;

// The getAll analogue over the param bag.
function all(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// The canonical URL for a selection — web's hrefForSelection, verbatim (the
// default My List is the bare `/links`).
function hrefForSelection(selection: Selection): string {
  if (selection.kind === 'all') return `/links?list=${ALL_ID}`;
  if (selection.kind === 'none') return '/links'; // no target axis → home (default inbox)
  if (selection.kind === 'tag') return `/links?tag=${encodeURIComponent(selection.id)}`;
  if (selection.id === DEFAULT_LIST_ID) return '/links';
  return `/links?list=${encodeURIComponent(selection.id)}`;
}

// Serialize a full `LinkQuery` back to the canonical URL — web's hrefForQuery,
// verbatim (repeated keys, bare-name sugar, sort deliberately NOT serialized).
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

  const qs = params.toString();
  return qs ? `/links?${qs}` : '/links';
}

// The param names that constitute a filter — web's FILTER_KEYS, verbatim
// (`sort`/`order` are read-only overrides, not filters).
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

// The URL sort override, or `undefined` when absent/unknown — the caller falls
// back to the setting default. Hand-typed exact enum literals only.
function sortOnParam(params: SearchParams): LinkSortOn | undefined {
  const value = first(params['sort']);
  return LINK_SORT_ONS.includes(value as LinkSortOn) ? (value as LinkSortOn) : undefined;
}

function sortOrderParam(params: SearchParams): LinkSortOrder | undefined {
  const value = first(params['order']);
  return LINK_SORT_ORDERS.includes(value as LinkSortOrder) ? (value as LinkSortOrder) : undefined;
}

// The params → `LinkQuery` grammar — web's parseLinkQuery over the param bag.
// `sortOn`/`sortOrder` arrive ALREADY RESOLVED (URL override ?? setting).
function parseLinkQuery(
  params: SearchParams,
  sortOn: LinkSortOn,
  sortOrder: LinkSortOrder,
): LinkQuery {
  const query: LinkQuery = {
    lists: {
      // `all` is the show-everything pseudo-list, not a real filter — drop it.
      any: [...all(params['list']), ...all(params['list-any'])].filter((id) => id !== ALL_ID),
      none: all(params['list-none']),
    },
    tags: {
      any: [...all(params['tag']), ...all(params['tag-any'])],
      all: all(params['tag-all']),
      none: all(params['tag-none']),
    },
    text: {
      all: words([...all(params['text']), ...all(params['text-all'])]),
      any: words(all(params['text-any'])),
      none: words(all(params['text-none'])),
    },
    url: {
      all: words([...all(params['url']), ...all(params['url-all'])]),
      any: words(all(params['url-any'])),
      none: words(all(params['url-none'])),
    },
    title: {
      all: words([...all(params['title']), ...all(params['title-all'])]),
      any: words(all(params['title-any'])),
      none: words(all(params['title-none'])),
    },
    sortOn,
    sortOrder,
  };

  // No filter params at all → the default inbox (My List). `?list=all` IS a
  // param, so it doesn't trigger the default.
  if (!FILTER_KEYS.some((key) => params[key] !== undefined)) {
    query.lists.any = [DEFAULT_LIST_ID];
  }
  return query;
}

// Project a `LinkQuery` onto the single-axis `Selection` — web's
// selectionFromQuery, verbatim (see there for why it derives off `query`, not
// the raw params).
function selectionFromQuery(q: LinkQuery): Selection {
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
  // Commit a SIMPLE query — one list/tag/all axis — as the canonical clean URL
  // (the sidebar). Named for what it writes, not the derived `selection`.
  setSimpleQuery: (selection: Selection) => void;
  // Commit an ARBITRARY query — the whole grammar — as the URL (the future
  // search editor). Both setters write the URL, the single source of truth.
  setQuery: (query: LinkQuery) => void;
  // The full filter the main pane reads through (`readLinks`).
  query: LinkQuery;
}

const LinksPageContext = createContext<LinksPageContextValue | null>(null);

export function LinksPageProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  // In the links layout this returns the focused links route's params — the
  // sidebar (drawer content) and the screen read the same bag.
  const params: SearchParams = useLocalSearchParams();

  // Sort: the hand-typed `?sort`/`?order` win, else the synced setting (coerced
  // from its tolerant `string` shape) — resolved here, the one place both are
  // visible, then stamped onto the query (web's rationale, verbatim).
  const { sortOn: settingSortOn, sortOrder: settingSortOrder } = useSettings();
  const sortOn = sortOnParam(params) ?? coerceLinkSortOn(settingSortOn);
  const sortOrder = sortOrderParam(params) ?? coerceLinkSortOrder(settingSortOrder);

  // Identity-stable per URL + resolved sort (it's a live-read dep in useLinks).
  // expo-router returns a NEW params object per render, so the memo keys on the
  // serialized bag — and parses it back inside, so the dep list is honest —
  // rather than the object identity web gets from useSearchParams.
  const paramsKey = JSON.stringify(params);
  const query = useMemo<LinkQuery>(() => {
    const bag = JSON.parse(paramsKey) as SearchParams;
    return parseLinkQuery(bag, sortOn, sortOrder);
  }, [paramsKey, sortOn, sortOrder]);

  // Selection is a derived PROJECTION of the query — never a separate read of
  // the URL — so it can never disagree with what the main pane shows.
  const selection = useMemo<Selection>(() => selectionFromQuery(query), [query]);

  // push (not replace) so the back gesture steps through the views you visited.
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

export function useLinksPage(): LinksPageContextValue {
  const value = useContext(LinksPageContext);
  if (!value) {
    throw new Error('useLinksPage must be used within a LinksPageProvider');
  }
  return value;
}

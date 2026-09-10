// Shared chrome state for the links screen — the expo port of bracemark-web's
// `(app)/links/_contexts/page-provider.tsx` (that file is the canonical doc for
// the grammar and the design: why selection is a derived PROJECTION of the
// query, why the URL params carry only opaque ids, the sort's
// URL-override-??-setting resolution). Divergences here:
//
//  - The "URL" is expo-router's route params (`/links?list=…`), read with
//    useGlobalSearchParams, held while another screen is on top (see
//    `useViewParams` below for why it can't be the local hook, and what the
//    hold protects) — same params, same grammar, so a link view
//    deep-links identically across web and native. Repeated keys
//    (`?tag=a&tag=b`) arrive as a string[] value instead of
//    URLSearchParams.getAll, hence `all()` below.
//  - Navigation is expo-router's router.push — which, aimed at the links
//    Drawer, is a navigate that REWRITES that navigator's one route (see
//    `useViewParams`). So unlike web's history, the back gesture does not step
//    back through the views visited on this page; it leaves the page.
//  - No Suspense boundary: route params have no prerender constraint.
//
// Lives in `src/features/links/` (not under `src/app/`) per the thin-routes
// convention — every file under the app root becomes a route.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';

import { useLists, useSettings, useTags } from '@stxapps/expo-react';
import {
  ALL_ID,
  coerceLinkSortOn,
  coerceLinkSortOrder,
  DEFAULT_LIST_ID,
  flattenTree,
  LINK_SORT_ONS,
  LINK_SORT_ORDERS,
  type LinkQuery,
  type LinkSortOn,
  type LinkSortOrder,
  type TreeItem,
  type TreeNode,
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

// This page's route, with no query on it — what every href below is built from,
// and what useViewParams compares the focused pathname against. `usePathname`
// strips the `(app)` group and pops the trailing `index`, so the `links`
// drawer's only screen reports exactly this.
const LINKS_PATHNAME = '/links';

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
    ['note', query.note],
  ] as const) {
    append(field, clause.all); // bare `text`/`url`/`title`/`note` = *-all
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
  'note',
  'note-all',
  'note-any',
  'note-none',
];

// Every param this screen reads — the filter keys plus the two sort overrides.
// The bag is narrowed to these before it's serialized (useViewParams), so a key
// that isn't part of the grammar can't churn `query`'s identity: the global read
// below hands back whatever the focused route carries, including expo-router's
// own `__internal__…` params, and `query` is a live-read dep (use-links) — an
// identity change there re-runs the whole paginated read.
const READ_KEYS = [...FILTER_KEYS, 'sort', 'order'];

// The params this view is filtered by, as a stable serialized bag. Two rules,
// both load-bearing:
//
// GLOBAL, NOT LOCAL. This provider is rendered by the links _LAYOUT_ (the
// drawer content needs the same context the screen reads), so it stands on the
// `links` route of the `(app)` stack — one level ABOVE the `index` route the
// query params actually land on. useLocalSearchParams resolves against the
// route that renders the calling component, so here it returns the LAYOUT's
// params, which are `{}` and STAY `{}`: a sidebar pick or a committed search is
// `router.push('/links?…')`, and expo-router targets the deepest navigator where
// the href and the current state diverge — the Drawer — where a push demotes to
// a navigate (the same demotion settings/close.ts documents) that rewrites only
// the drawer's `index` route. Nothing ever writes the layout's own route, so the
// page parsed an empty bag forever: no FILTER_KEYS present is the DEFAULT_LIST_ID
// branch, i.e. every view — every list, every tag, every search — resolved to My
// List, with nothing for the read edge to re-run. useGlobalSearchParams reads
// the focused route chain off the navigation state instead (params merged down
// the chain and decoded, expo-router's nested `screen`/`params` stripped), which
// is exactly the `index` params. NOTHING LINTS THIS — both hooks return a
// plausible bag, and the failure is a screen that quietly never changes.
//
// HELD WHILE ANOTHER SCREEN IS ON TOP. "Global" means it follows whatever route
// is focused, including ones that are not this page: pushing `/settings/general`
// or `/edit-link` swings this hook onto THAT route's params, where the
// no-filter-keys default parses out as My List — resetting the list, the drawer
// highlight, the FlashList offset and bulk-edit mode under a screen the user is
// still looking past (the editor presents modally) and expects to come back to.
// That is the round trip settings/close.ts's `dismiss()` exists to preserve. So
// a bag is only TAKEN while the focused route is this page, and the last one
// taken holds until it is again.
//
// The gate is the focused PATHNAME, deliberately not `useIsFocused()`: that
// hook's value is state fed by React Navigation's focus/blur events, so it lags
// the params by a render, and the one render where the new route's params are
// already visible and `isFocused` is still true is the render that poisons the
// held bag — the reset happens anyway, one frame later. Pathname and params come
// out of the SAME route-info snapshot, so they cannot disagree by construction.
function useViewParams(): SearchParams {
  const focused: SearchParams = useGlobalSearchParams();
  const onThisPage = usePathname() === LINKS_PATHNAME;

  const focusedKey = useMemo(() => {
    const bag: SearchParams = {};
    for (const key of READ_KEYS) {
      if (focused[key] !== undefined) bag[key] = focused[key];
    }
    return JSON.stringify(bag); // READ_KEYS order → deterministic per bag
  }, [focused]);

  // State adjusted DURING render, so the parse below sees the current bag on the
  // very render the page comes back rather than a frame later (use-links's
  // rationale).
  const [paramsKey, setParamsKey] = useState(focusedKey);
  if (onThisPage && focusedKey !== paramsKey) setParamsKey(focusedKey);

  // Parsed back from the string, so the memo's dep list is honest — the params
  // object itself is fresh whenever route info is recomputed, where web gets
  // object identity from useSearchParams.
  return useMemo(() => JSON.parse(paramsKey) as SearchParams, [paramsKey]);
}

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
    note: {
      all: words([...all(params['note']), ...all(params['note-all'])]),
      any: words(all(params['note-any'])),
      none: words(all(params['note-none'])),
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
    q.title.none.length +
    q.note.all.length +
    q.note.any.length +
    q.note.none.length;
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

// Does this tree still hold that id? Flattened, since the match may be at any
// depth — the same lookup the topbar does to name the selection.
function treeHasId<T extends TreeItem>(tree: TreeNode<T>[], id: string): boolean {
  return flattenTree(tree).some((n) => n.item.id === id);
}

// A selection whose list or tag was DELETED while this screen still names it —
// web's isStaleSelection, verbatim (see there for why only a single-axis
// selection is judged, and why an empty tree is never taken as proof of
// absence: both hooks collapse "still loading" into `[]`, so only a NON-empty
// tree can convict).
function isStaleSelection<L extends TreeItem, T extends TreeItem>(
  selection: Selection,
  lists: TreeNode<L>[],
  tags: TreeNode<T>[],
): boolean {
  if (selection.kind === 'list') return lists.length > 0 && !treeHasId(lists, selection.id);
  if (selection.kind === 'tag') return tags.length > 0 && !treeHasId(tags, selection.id);
  return false;
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
  // The focused links route's params — the sidebar (drawer content) and the
  // screen read the same bag. Identity-stable per view; see useViewParams for
  // the two rules that make it so, and for why it is not the local hook.
  const params = useViewParams();

  // Sort: the hand-typed `?sort`/`?order` win, else the synced setting (coerced
  // from its tolerant `string` shape) — resolved here, the one place both are
  // visible, then stamped onto the query (web's rationale, verbatim).
  const { sortOn: settingSortOn, sortOrder: settingSortOrder } = useSettings();
  const sortOn = sortOnParam(params) ?? coerceLinkSortOn(settingSortOn);
  const sortOrder = sortOrderParam(params) ?? coerceLinkSortOrder(settingSortOrder);

  // Identity-stable per view + resolved sort (it's a live-read dep in useLinks:
  // a new reference re-runs the paginated read, an unchanged one holds it).
  const query = useMemo<LinkQuery>(
    () => parseLinkQuery(params, sortOn, sortOrder),
    [params, sortOn, sortOrder],
  );

  // Selection is a derived PROJECTION of the query — never a separate read of
  // the URL — so it can never disagree with what the main pane shows.
  const selection = useMemo<Selection>(() => selectionFromQuery(query), [query]);

  // The deleted-entity fallback (isStaleSelection): the list or tag this screen
  // is filtered by no longer exists, so send it home rather than leave it on a
  // dead end — a topbar reading "Unknown" over an empty list, with nothing to
  // say the thing is gone rather than empty. `replace`, not `push`: the view
  // being left doesn't exist, so it must not become a back-gesture destination.
  //
  // GATED ON FOCUS, which web needs no equivalent of. Deleting a list happens in
  // SETTINGS, and this provider stays mounted under it the whole time (it wraps
  // the links navigator, a sibling card in the `(app)` stack — the same fact
  // settings/close.ts pops back onto). An ungated effect would therefore fire
  // while settings is the focused screen, and `replace` acts on the focused card
  // — it would swap SETTINGS out from under the user mid-edit. Focused, it fires
  // the moment settings is dismissed, on the screen it's actually about.
  const isFocused = useIsFocused();
  const lists = useLists();
  const tags = useTags();
  const stale = isFocused && isStaleSelection(selection, lists, tags);
  useEffect(() => {
    if (stale) router.replace('/links');
  }, [stale, router]);

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

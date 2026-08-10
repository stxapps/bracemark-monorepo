// The link-query GRAMMAR — how a link view/search is described, independent of
// any storage engine. Hoisted from web-react's read layer when bracemark-expo grew
// its own (the same move as `WithPath`/`LinkItem` → items.ts): the grammar is a
// cross-platform contract — bracemark-web's page-provider authors it from the URL,
// both read layers (web-react's Dexie `readLinks`, expo-react's SQLite port)
// evaluate it — so it lives here beside the entity shapes, and each platform's
// queries.ts stays the engine, not the contract. Pure types + transforms, no
// storage, no decode — unit-testable in isolation (link-query.spec.ts).

import type { LinkSortOn, LinkSortOrder } from './entities';

// One filter clause over a multi-valued or text field. Three relations, ANDed
// together, each ignored when empty:
//   any  — match if the field has/contains ANY of these (OR / include-any)
//   all  — match if it has/contains ALL of these (AND / include-all)
//   none — match if it has/contains NONE of these (NOT / exclude)
// For tags `any/all/none` apply to the link's tag-id set; for `url`/`title` they
// apply to lowercased substring word matches.
export interface Clause {
  any: string[];
  all: string[];
  none: string[];
}

// A link belongs to exactly ONE list, so `all` (in two lists at once) is always
// empty — lists support only `any` (in one of these) and `none` (in none).
export interface ListClause {
  any: string[];
  none: string[];
}

// How results are ordered, along two orthogonal axes (`LinkSortOn`/`LinkSortOrder`
// live in entities.ts beside the synced-setting writer enums): `sortOn` is the
// field — `updatedAt` = date modified, `createdAt` = date added — and `sortOrder`
// the direction (`desc` = newest first). Each read layer backs a sort with its own
// index, so no sort runs in memory.

// A fully-described link query. Clauses AND across fields (a link must satisfy
// every non-empty one). Cross-field OR is intentionally not expressible — that's
// a structured-AST concern, out of scope.
export interface LinkQuery {
  lists: ListClause;
  tags: Clause;
  // Basic search: substring words matched against the COMBINED url⊕title haystack
  // (host lives inside url), so a word may land in EITHER field — the "search
  // words, all links" free rung, one clause behind one box. `url`/`title` below are
  // the field-scoped (advanced) counterparts; `text` ANDs with them and with
  // lists/tags like every other clause. It carries the title half, so — like a
  // `title` clause — it forces the link↔extraction join in the read layers.
  text: Clause;
  url: Clause;
  title: Clause;
  // Ordering, not a filter. Resolved by the app's read edge (bracemark-web
  // page-provider): a global synced setting (settings/general.enc) with an
  // optional READ-ONLY URL override (`?sort`/`?order`, hand-typed) — the URL wins
  // when present, else the setting. By the time a query reaches a read layer it's
  // a concrete field+direction. See docs/search.md.
  sortOn: LinkSortOn;
  sortOrder: LinkSortOrder;
}

// A blank query — every clause empty, default sort. The base the search UI builds
// on (spread + fill the fields it sets), so callers never hand-assemble the full
// clause shape (and can't drift from it when a field is added). A factory, not a
// shared const, so no caller can mutate a shared clause array.
export function emptyQuery(): LinkQuery {
  return {
    lists: { any: [], none: [] },
    tags: { any: [], all: [], none: [] },
    text: { any: [], all: [], none: [] },
    url: { any: [], all: [], none: [] },
    title: { any: [], all: [], none: [] },
    sortOn: 'updatedAt',
    sortOrder: 'desc',
  };
}

// Rewrite a query to EXCLUDE a set of list ids, preserving the cheapest driver
// a read layer can pick. Pure grammar in, grammar out — the caller decides WHICH
// ids to suppress and why (e.g. lock coverage folds its locked set through here;
// see bracemark-web's use-links). Shaped to keep the single-list index fast path
// (the read layers bail to a filtered walk whenever `lists.none` is non-empty,
// losing the exact count):
//   - nothing to exclude → the SAME query reference (identity matters: callers
//     key their live query and page-identity checks off it — see use-links);
//   - a positive list filter already excludes everything outside it, so excluded
//     ids are REMOVED from `any` instead of added to `none` — a single-list view
//     stays on the fast path even while other lists are excluded;
//   - if that empties `any` (every requested list is excluded), the query must
//     match NOTHING — not fall through to "no list filter" — so the ids stay in
//     `any` AND go into `none`, which the column predicate resolves to zero;
//   - only the no-positive-filter views (Show All, tags, search) pay the `none`
//     clause.
export function excludeLists(query: LinkQuery, listIds: ReadonlySet<string>): LinkQuery {
  if (listIds.size === 0) return query;

  if (query.lists.any.length > 0) {
    const any = query.lists.any.filter((id) => !listIds.has(id));
    if (any.length === query.lists.any.length) return query;
    if (any.length > 0) return { ...query, lists: { ...query.lists, any } };
    return {
      ...query,
      lists: { any: query.lists.any, none: [...query.lists.none, ...query.lists.any] },
    };
  }

  return {
    ...query,
    lists: { ...query.lists, none: [...query.lists.none, ...listIds] },
  };
}

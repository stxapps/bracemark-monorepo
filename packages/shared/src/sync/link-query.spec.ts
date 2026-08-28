import { excludeLists, hasPositiveNoteClause, type LinkQuery } from './link-query';

// A base query with the given list clause; other clauses empty, sort fixed.
const q = (any: string[], none: string[] = []): LinkQuery => ({
  lists: { any, none },
  tags: { any: [], all: [], none: [] },
  text: { any: [], all: [], none: [] },
  url: { any: [], all: [], none: [] },
  title: { any: [], all: [], none: [] },
  note: { any: [], all: [], none: [] },
  sortOn: 'updatedAt',
  sortOrder: 'desc',
});

describe('excludeLists', () => {
  it('returns the SAME reference when there is nothing to exclude', () => {
    // Identity matters: use-links keys its live query + page-identity checks off
    // the returned reference, so "no exclusion" must not mint a new object.
    const query = q([], []);
    expect(excludeLists(query, new Set())).toBe(query);
  });

  it('returns the SAME reference when no requested list intersects the excluded set', () => {
    const query = q(['a'], []);
    expect(excludeLists(query, new Set(['x', 'y']))).toBe(query);
  });

  // No positive list filter (Show All / tags / search): excluded ids go into
  // `none` — the only view that pays the `none` clause.
  it('adds excluded ids to `none` when there is no positive list filter', () => {
    const result = excludeLists(q([], ['keep']), new Set(['b', 'c']));
    expect(result.lists.any).toEqual([]);
    expect(new Set(result.lists.none)).toEqual(new Set(['keep', 'b', 'c']));
  });

  // A positive list filter already excludes everything outside it, so an excluded
  // id is REMOVED from `any` rather than added to `none` — keeping a still-allowed
  // single-list view on the read layers' fast path.
  it('removes excluded ids from `any`, leaving the fast path intact', () => {
    const result = excludeLists(q(['a', 'b', 'c']), new Set(['b']));
    expect(result.lists.any).toEqual(['a', 'c']);
    expect(result.lists.none).toEqual([]);
  });

  // If exclusion empties `any` (every requested list is excluded), the query must
  // match NOTHING — not fall through to "no list filter". The ids stay in `any`
  // AND go into `none`, which the column predicate resolves to zero.
  it('matches nothing when every requested list is excluded', () => {
    const result = excludeLists(q(['a', 'b'], ['pre']), new Set(['a', 'b']));
    expect(result.lists.any).toEqual(['a', 'b']);
    expect(new Set(result.lists.none)).toEqual(new Set(['pre', 'a', 'b']));
  });

  it('does not mutate the input query', () => {
    const query = q(['a', 'b'], ['pre']);
    const snapshot = JSON.stringify(query);
    excludeLists(query, new Set(['a']));
    expect(JSON.stringify(query)).toBe(snapshot);
  });
});

describe('hasPositiveNoteClause', () => {
  const withNote = (note: Partial<LinkQuery['note']>): LinkQuery => ({
    ...q([]),
    note: { any: [], all: [], none: [], ...note },
  });

  it('is false for a query with no note clause', () => {
    expect(hasPositiveNoteClause(q([]))).toBe(false);
  });

  it('is true for an `all` term', () => {
    expect(hasPositiveNoteClause(withNote({ all: ['recipe'] }))).toBe(true);
  });

  it('is true for an `any` term', () => {
    expect(hasPositiveNoteClause(withNote({ any: ['recipe', 'dinner'] }))).toBe(true);
  });

  // The badge must NOT light here: a `none`-only clause is satisfied by links that
  // do NOT contain the words — including every link with no note at all — so a
  // surviving row matched by absence and its note has nothing to show.
  it('is false for a `none`-only clause', () => {
    expect(hasPositiveNoteClause(withNote({ none: ['draft'] }))).toBe(false);
  });

  it('is true when a positive term sits alongside a `none` term', () => {
    expect(hasPositiveNoteClause(withNote({ all: ['recipe'], none: ['draft'] }))).toBe(true);
  });
});

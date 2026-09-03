/**
 * @jest-environment jsdom
 */
// The read edge does two jobs, and both fail without saying anything.
//
// SUPPRESSION is the enforcement edge for list locks: every read path — Show
// All, tag views, text search, the pinned overlay, a hand-built deep link — has
// to exclude a locked list's links, because the main pane's lock pane is only
// chrome. A regression here shows the locked links, correctly rendered, with no
// error anywhere. Trash rides the same mechanism but with the opposite polarity:
// suppressed by default, restored when the QUERY asks for it — and the gate has
// to key off the query rather than `selection`, because selection is a lossy
// projection that collapses "Trash + some text" to `none` and would silently
// empty an explicit search. The assertions are at the WIRE (what `readLinks` was
// handed) rather than on the `suppressedListIds` expression, which would just
// restate the code; `excludeLists` itself is shared's subject and is the real one
// here, not a stand-in.
//
// STAGING is why the list doesn't shift under a user's hand. `live` keeps
// flowing and `displayed` is promoted from it only when a repaint won't disrupt —
// and the decision runs DURING RENDER, because `hasPending` is derived from
// `displayed`: promote in an effect and React commits one frame that still
// reports the pill, so the pill flashes on the user's own edit. That flash is
// exactly the kind of thing no assertion downstream of a commit can see, so the
// spec reads `hasPending` on every render rather than after settling.
//
// The local-write grace window is the other ordering hazard: a mutation can
// reach this hook in either order (`requestSync` bumps the nonce synchronously
// after its write, but the live re-run is async, and a multi-write op can land a
// re-run BEFORE the bump), so the window has to open during render too.

import { act, render } from '@testing-library/react';

import { ALL_ID, type LinkQuery, TRASH_ID } from '@stxapps/shared';
import type { LinkView } from '@stxapps/web-react';

import { useLinks } from './use-links';

// A LinksResult shaped like the read layer's, echoing the page it ran for.
interface Result {
  links: LinkView[];
  pinnedCount: number;
  total?: number;
  hasMore: boolean;
  query: LinkQuery;
  limit: number;
}

let mockQuery: LinkQuery;
let mockLockedListIds = new Set<string>();
let mockNonce = 0;
let mockEngaged = false;

// The live read's current answer, and the callbacks that re-run the querier —
// what a Dexie write does on its own.
let liveResult: Result | undefined;
const refreshers = new Set<() => void>();

const readLinks = jest.fn((query: LinkQuery, limit: number): Promise<Result> =>
  Promise.resolve(liveResult ?? { links: [], pinnedCount: 0, hasMore: false, query, limit }),
);

jest.mock('dexie-react-hooks', () => ({
  // A stand-in for Dexie's liveQuery: run the querier, re-run it on demand. This
  // hook depends on the ANSWER arriving and on useLiveQuery's documented
  // one-render lag (the previous result is returned for one render after the deps
  // change), both of which this reproduces; it does not depend on the tracking
  // zone.
  useLiveQuery: (querier: () => Promise<unknown>, deps: unknown[]) => {
    const react = jest.requireActual('react') as typeof import('react');
    const [value, setValue] = react.useState<unknown>(undefined);
    const run = react.useCallback(() => {
      void Promise.resolve(querier()).then(setValue);
    }, deps);
    react.useEffect(() => {
      run();
      refreshers.add(run);
      return () => void refreshers.delete(run);
    }, [run]);
    return value;
  },
}));

jest.mock('@stxapps/web-react', () => ({
  // The real thing — its behaviour is shared's own subject
  // (sync/link-query.spec.ts), and a stand-in here would test the stand-in.
  excludeLists: (jest.requireActual('@stxapps/shared') as typeof import('@stxapps/shared'))
    .excludeLists,
  readLinks: (query: LinkQuery, limit: number) => readLinks(query, limit),
  useLocks: () => ({ lockedListIds: mockLockedListIds }),
  useSync: () => ({ localWriteNonce: mockNonce }),
}));

jest.mock('../_contexts/page-provider', () => ({
  useLinksPage: () => ({ query: mockQuery }),
}));

jest.mock('../_contexts/view-state-provider', () => ({
  useLinksViewState: () => ({ engaged: mockEngaged }),
}));

// Build the URL-side query the provider would hand down. Identity matters — the
// hook and the live read both key on this exact reference — so a view change in a
// test means a NEW object, as a real navigation produces.
const queryFor = (listsAny: string[] = [], overrides: Partial<LinkQuery> = {}): LinkQuery => ({
  lists: { any: listsAny, none: [] },
  tags: { any: [], all: [], none: [] },
  text: { any: [], all: [], none: [] },
  url: { any: [], all: [], none: [] },
  title: { any: [], all: [], none: [] },
  note: { any: [], all: [], none: [] },
  sortOn: 'updatedAt',
  sortOrder: 'desc',
  ...overrides,
});

const rowsOf = (...paths: string[]) =>
  paths.map((path) => ({ path, updatedAt: 1 }) as unknown as LinkView);

// A result for whatever page the hook is currently asking for.
function resultOf(rows: LinkView[], extra: Partial<Result> = {}): Result {
  const [lastQuery, lastLimit] = readLinks.mock.calls.at(-1) ?? [mockQuery, 50];
  return {
    links: rows,
    pinnedCount: 0,
    total: rows.length,
    hasMore: false,
    query: lastQuery,
    limit: lastLimit,
    ...extra,
  };
}

// Two logs, and the difference between them is the whole point of deciding
// during render. `renders` holds every render ATTEMPT, including the one React
// throws away when this hook promotes mid-render; `commits` holds only the
// frames that reached the DOM, because a `useEffect` in a discarded render never
// runs. A pill that "flashes" is a committed frame reporting `hasPending`.
let renders: ReturnType<typeof useLinks>[] = [];
let commits: ReturnType<typeof useLinks>[] = [];

function Probe() {
  const result = useLinks();
  renders.push(result);
  const react = jest.requireActual('react') as typeof import('react');
  react.useEffect(() => {
    commits.push(result);
  });
  return null;
}

const current = () => renders[renders.length - 1];

// Let the mocked live read resolve into state.
const settle = () => act(async () => undefined);

// Publish a new live answer and re-run every querier — what a sync landing does.
async function publish(result: Result) {
  liveResult = result;
  await act(async () => {
    for (const run of refreshers) run();
  });
}

// The page `readLinks` was last asked for. Throws rather than asserting
// non-null, so a spec that never reached the read says so instead of failing on
// a property of undefined.
function lastPage(): [LinkQuery, number] {
  const call = readLinks.mock.calls.at(-1);
  if (!call) throw new Error('readLinks was never called');
  return call;
}

const lastRead = () => lastPage()[0];
const lastLimit = () => lastPage()[1];

async function mount() {
  renders = [];
  commits = [];
  const view = render(<Probe />);
  await settle();
  return {
    ...view,
    // A re-render driven by something outside this hook (a nonce bump, a
    // navigation) — the same thing a parent re-render does.
    poke: async () => {
      await act(async () => view.rerender(<Probe />));
    },
  };
}

describe('useLinks', () => {
  beforeEach(() => {
    mockQuery = queryFor(['my-list']);
    mockLockedListIds = new Set();
    mockNonce = 0;
    mockEngaged = false;
    liveResult = undefined;
    refreshers.clear();
    readLinks.mockClear();
  });

  describe('what never reaches the read', () => {
    it('suppresses Trash in an unfiltered view', async () => {
      mockQuery = queryFor([]); // Show All
      await mount();
      expect(lastRead().lists.none).toContain(TRASH_ID);
    });

    it('restores Trash when the query asks for it', async () => {
      mockQuery = queryFor([TRASH_ID]);
      await mount();
      expect(lastRead().lists.none).not.toContain(TRASH_ID);
      expect(lastRead().lists.any).toEqual([TRASH_ID]);
    });

    // The gate keys off the QUERY, not `selection` — which collapses this to
    // `none` and would silently empty an explicit request made from the advanced
    // search editor.
    it('restores Trash for a compound "Trash + some text" search', async () => {
      mockQuery = queryFor([TRASH_ID], { text: { any: [], all: ['hello'], none: [] } });
      await mount();
      expect(lastRead().lists.none).not.toContain(TRASH_ID);
    });

    // Locks are enforcement, so no query can opt out of them. These are the views
    // with no positive list filter — the ones where a locked list's links would
    // otherwise be indistinguishable from any other row, and where the `none`
    // clause is the only thing keeping them out.
    it.each<[string, LinkQuery]>([
      ['show all', queryFor([])],
      ['a tag view', queryFor([], { tags: { any: ['tag-1'], all: [], none: [] } })],
      ['a text search', queryFor([], { text: { any: [], all: ['hello'], none: [] } })],
    ])('suppresses a locked list in %s', async (_label, query) => {
      mockQuery = query;
      mockLockedListIds = new Set(['locked-list']);
      await mount();
      expect(lastRead().lists.none).toContain('locked-list');
    });

    // A positive list view keeps its exact-count fast path: the suppressed ids
    // aren't in its `any`, so nothing is added and the query is handed through
    // untouched.
    it('leaves a positive list view on its fast path', async () => {
      mockQuery = queryFor(['list-abc']);
      mockLockedListIds = new Set(['locked-list']);
      await mount();
      expect(lastRead()).toBe(mockQuery);
    });

    // Navigating INTO a locked list is not a way in: every requested list being
    // excluded must match nothing rather than falling through to "no filter".
    it('empties the view rather than widening it when the only list is locked', async () => {
      mockQuery = queryFor(['locked-list']);
      mockLockedListIds = new Set(['locked-list']);
      await mount();
      expect(lastRead().lists.none).toContain('locked-list');
      expect(lastRead().lists.any).toEqual(['locked-list']);
    });

    // `?list=all` is dropped by the provider, so Show All arrives as an empty
    // clause — the case that pays the `none` clause rather than the fast path.
    it('never lets ALL_ID stand in for the absent suppression', async () => {
      mockQuery = queryFor([]);
      mockLockedListIds = new Set(['locked-list']);
      await mount();
      expect(lastRead().lists.any).not.toContain(ALL_ID);
      expect(lastRead().lists.none).toEqual(expect.arrayContaining(['locked-list', TRASH_ID]));
    });
  });

  describe('staging a background repaint', () => {
    it('reports loading until the first result lands, then paints it', async () => {
      liveResult = resultOf(rowsOf('a', 'b'));
      renders = [];
      render(<Probe />);
      expect(current().isLoading).toBe(true);
      expect(current().total).toBeUndefined(); // distinct from a real empty result

      await settle();
      expect(current().isLoading).toBe(false);
      expect(current().links.map((l) => l.path)).toEqual(['a', 'b']);
      expect(current().hasPending).toBe(false);
    });

    it('paints a background result immediately while the user is idle', async () => {
      liveResult = resultOf(rowsOf('a'));
      await mount();

      await publish(resultOf(rowsOf('new', 'a')));
      expect(current().links.map((l) => l.path)).toEqual(['new', 'a']);
      expect(current().hasPending).toBe(false);
    });

    it('holds a background result back while the user is engaged', async () => {
      liveResult = resultOf(rowsOf('a'));
      await mount();

      mockEngaged = true;
      await publish(resultOf(rowsOf('new', 'a')));

      expect(current().links.map((l) => l.path)).toEqual(['a']);
      expect(current().hasPending).toBe(true);
    });

    it('swaps the held result in when the refresh pill is pressed', async () => {
      liveResult = resultOf(rowsOf('a'));
      await mount();
      mockEngaged = true;
      await publish(resultOf(rowsOf('new', 'a')));

      await act(async () => current().applyPending());
      expect(current().links.map((l) => l.path)).toEqual(['new', 'a']);
      expect(current().hasPending).toBe(false);
    });

    // A write to an unrelated record still re-fires the live query. Lighting the
    // pill for a re-run that returns identical content trains the user to ignore
    // it.
    it('does not light the pill for a re-run with identical content', async () => {
      liveResult = resultOf(rowsOf('a', 'b'));
      await mount();
      mockEngaged = true;

      await publish(resultOf(rowsOf('a', 'b')));
      expect(current().hasPending).toBe(false);
    });

    // The user's own edit is not a disruption, so it applies at once — and the
    // pill must never appear on the way, which is what makes the during-render
    // decision load-bearing rather than a style choice.
    it('applies this device’s own edit at once, without flashing the pill', async () => {
      liveResult = resultOf(rowsOf('a'));
      await mount();
      mockEngaged = true;

      mockNonce = 1; // requestSync bumped it
      liveResult = resultOf(rowsOf('edited', 'a'));
      const before = commits.length;
      await act(async () => {
        for (const run of refreshers) run();
      });

      expect(current().links.map((l) => l.path)).toEqual(['edited', 'a']);
      // Not one painted frame carried the pill. Promoting in an effect instead
      // necessarily commits a frame that still holds the old snapshot and
      // therefore reports `hasPending`, which the browser paints.
      expect(commits.slice(before).map((r) => r.hasPending)).not.toContain(true);
      expect(commits.length).toBeGreaterThan(before);
    });

    // The grace window covers both re-runs one edit triggers regardless of which
    // arrives first — including a live result that lands BEFORE the nonce bump.
    it('applies a re-run that arrives before the nonce bump', async () => {
      liveResult = resultOf(rowsOf('a'));
      await mount();
      mockEngaged = true;

      // The multi-write op's first re-run, ahead of requestSync's bump.
      await publish(resultOf(rowsOf('mid', 'a')));
      expect(current().links.map((l) => l.path)).toEqual(['a']); // staged so far

      mockNonce = 1;
      await publish(resultOf(rowsOf('after', 'mid', 'a')));
      expect(current().links.map((l) => l.path)).toEqual(['after', 'mid', 'a']);
    });
  });

  describe('changing the page', () => {
    it('grows the page on "show more" and re-reads for the larger limit', async () => {
      liveResult = resultOf(rowsOf('a'), { hasMore: true });
      const { poke } = await mount();
      expect(current().hasMore).toBe(true);
      expect(lastLimit()).toBe(50);

      await act(async () => current().showMore());
      await poke();
      expect(lastLimit()).toBe(100);
    });

    // A new query is a fresh page: inheriting a grown limit would re-read
    // thousands of rows for a view the user just arrived at.
    it('resets the page size when the view changes', async () => {
      liveResult = resultOf(rowsOf('a'), { hasMore: true });
      const { poke } = await mount();
      await act(async () => current().showMore());
      await poke();
      expect(lastLimit()).toBe(100);

      mockQuery = queryFor(['other-list']);
      await poke();
      expect(lastLimit()).toBe(50);
    });

    // Navigation is the user's own action, so the new page replaces the snapshot
    // rather than staging behind it — even mid-scroll, mid-menu.
    it('paints a new view immediately even while engaged', async () => {
      liveResult = resultOf(rowsOf('a'));
      const { poke } = await mount();
      mockEngaged = true;

      mockQuery = queryFor(['other-list']);
      await poke();
      liveResult = resultOf(rowsOf('x', 'y'));
      await publish(liveResult);

      expect(current().links.map((l) => l.path)).toEqual(['x', 'y']);
      expect(current().hasPending).toBe(false);
    });

    // Page identity is read off the RESULT (readLinks echoes the query/limit it
    // ran for) rather than diffed against a prev-render ref, and this is the case
    // that needs it: two navigations in quick succession, then the FIRST one's
    // read lands. It is a page change — so the "navigation promotes even while
    // engaged" rule fires — but it is a change to a view the user has already
    // left, and promoting it paints another view's links under the current
    // view's title.
    it('does not adopt a result from a page the user has already left', async () => {
      liveResult = resultOf(rowsOf('a'));
      const { poke } = await mount();
      mockEngaged = true;

      mockQuery = queryFor(['second']);
      await poke();
      const [secondQuery, secondLimit] = lastPage();

      mockQuery = queryFor(['third']);
      await poke();
      const [thirdQuery, thirdLimit] = lastPage();

      // The second view's read resolves after the user is already on the third.
      await publish({
        links: rowsOf('second-row'),
        pinnedCount: 0,
        total: 1,
        hasMore: false,
        query: secondQuery,
        limit: secondLimit,
      });
      expect(current().links.map((l) => l.path)).toEqual(['a']);

      // The view actually on screen lands, and that one does promote.
      await publish({
        links: rowsOf('third-row'),
        pinnedCount: 0,
        total: 1,
        hasMore: false,
        query: thirdQuery,
        limit: thirdLimit,
      });
      expect(current().links.map((l) => l.path)).toEqual(['third-row']);
    });
  });
});

/**
 * @jest-environment jsdom
 */
// The links view IS the URL, so this provider is the whole read/write edge of a
// grammar (docs/search.md) — and both directions fail quietly. A parse that
// misreads a param shows the wrong links with no error; a serializer that emits a
// spelling the parser doesn't read back gives a search that works until you press
// Back, at which point it silently widens. Nothing types the two halves against
// each other: they are two private functions in one file, one building a string
// and one reading one.
//
// `@stxapps/shared`'s link-query.spec.ts owns what a `LinkQuery` MEANS, and the
// expo mirror's spec (features/links/page-provider.spec.tsx) owns whether a
// navigation reaches the provider at all — a native-only hazard. Neither touches
// the URL grammar, which is web's alone. So this spec sits on:
//
//   - the bare-name sugar (`?list=` is list-ANY, `?text=` is text-ALL) and the
//     suffixed relations hand-built deep links already rely on;
//   - `?list=all` being a param that expresses NO list filter — the one value
//     that must both suppress the default-inbox injection and leave the clause
//     empty, which two separate lines of the parser have to agree on;
//   - the ROUND TRIP, asserted by feeding the serializer's output back through
//     the parser, since that is the property neither half can hold alone;
//   - `selection`, the lossy projection the sidebar highlights from — where the
//     interesting cases are the ones that must NOT highlight;
//   - `?sort`/`?order` as a read-only override of the synced setting, which the
//     serializer must then drop;
//   - the stale-selection bounce and its POSITIVE-EVIDENCE guard, whose failure
//     mode is a cold load of a shared list URL bouncing to the inbox.

import { act, render } from '@testing-library/react';

import {
  ALL_ID,
  DEFAULT_LIST_ID,
  type LinkQuery,
  type TreeItem,
  type TreeNode,
} from '@stxapps/shared';

import { LinksPageProvider, type Selection, useLinksPage } from './page-provider';

let mockSearch = '';
let mockLists: TreeNode<TreeItem>[] = [];
let mockTags: TreeNode<TreeItem>[] = [];
let mockSetting = { sortOn: 'updatedAt', sortOrder: 'desc' };

const push = jest.fn();
const replace = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

jest.mock('@stxapps/web-react', () => ({
  useLists: () => mockLists,
  useTags: () => mockTags,
  useSettings: () => mockSetting,
}));

const recordLinksReturn = jest.fn();
jest.mock('@/lib/links-return', () => ({
  recordLinksReturn: (href: string) => recordLinksReturn(href),
}));

// A tree node. Only `item.id` is read by the provider — it is generic over the
// two entity shapes precisely so it needs no entity types — but the rest of
// TreeItem is filled in so this is a real one rather than a cast.
const node = (id: string, children: TreeNode<TreeItem>[] = []): TreeNode<TreeItem> => ({
  item: { id, parentId: null, rank: 'a' },
  depth: 0,
  children,
});

let api: ReturnType<typeof useLinksPage>;

function Probe() {
  api = useLinksPage();
  return null;
}

// Mount the provider at `search` and hand back what the page reads.
function mountAt(search: string) {
  mockSearch = search;
  render(
    <LinksPageProvider>
      <Probe />
    </LinksPageProvider>,
  );
  return api;
}

// The serializer, reached the only way a call site can: commit a query and read
// the href `setQuery` pushed.
function serialize(query: LinkQuery): string {
  const { setQuery } = mountAt('');
  push.mockClear();
  act(() => setQuery(query));
  return push.mock.calls[0][0] as string;
}

// A LinkQuery with every clause empty, for building one clause at a time.
const emptyQuery = (): LinkQuery => ({
  lists: { any: [], none: [] },
  tags: { any: [], all: [], none: [] },
  text: { any: [], all: [], none: [] },
  url: { any: [], all: [], none: [] },
  title: { any: [], all: [], none: [] },
  note: { any: [], all: [], none: [] },
  sortOn: 'updatedAt',
  sortOrder: 'desc',
});

describe('LinksPageProvider', () => {
  beforeEach(() => {
    mockLists = [];
    mockTags = [];
    mockSetting = { sortOn: 'updatedAt', sortOrder: 'desc' };
    push.mockClear();
    replace.mockClear();
    recordLinksReturn.mockClear();
  });

  describe('reading the URL', () => {
    it('injects the default inbox when no filter param is present', () => {
      const { query, selection } = mountAt('');
      expect(query.lists.any).toEqual([DEFAULT_LIST_ID]);
      expect(selection).toEqual({ kind: 'list', id: DEFAULT_LIST_ID });
    });

    // `?list=all` is a param, so it suppresses the injection above — and it is
    // then dropped, because Show All is the absence of a list filter rather than a
    // filter naming a pseudo-list. Both halves have to hold or Show All shows
    // either the inbox or nothing.
    it('reads ?list=all as no list filter at all', () => {
      const { query, selection } = mountAt(`list=${ALL_ID}`);
      expect(query.lists.any).toEqual([]);
      expect(selection).toEqual({ kind: 'all' });
    });

    // A `?sort=` alone is not a filter, so it must not suppress the default inbox.
    it('still lands on the inbox when the URL carries only a sort override', () => {
      const { query } = mountAt('sort=createdAt');
      expect(query.lists.any).toEqual([DEFAULT_LIST_ID]);
      expect(query.sortOn).toBe('createdAt');
    });

    it('reads the bare names as their sugared relation', () => {
      const { query } = mountAt('list=list-abc&tag=tag-1&text=hello&url=example&title=doc');
      expect(query.lists.any).toEqual(['list-abc']); // bare list = list-any
      expect(query.tags.any).toEqual(['tag-1']); // bare tag  = tag-any
      expect(query.text.all).toEqual(['hello']); // bare text = text-all
      expect(query.url.all).toEqual(['example']);
      expect(query.title.all).toEqual(['doc']);
    });

    it('merges a bare name with its explicit long form rather than letting one win', () => {
      const { query } = mountAt('tag=tag-1&tag-any=tag-2&text=one&text-all=two');
      expect(query.tags.any).toEqual(['tag-1', 'tag-2']);
      expect(query.text.all).toEqual(['one', 'two']);
    });

    it('reads every suffixed relation a hand-built deep link can use', () => {
      const { query } = mountAt(
        'list-none=trash&tag-all=a&tag-none=b&text-any=x&text-none=y&note=n&note-any=m',
      );
      expect(query.lists.none).toEqual(['trash']);
      expect(query.tags.all).toEqual(['a']);
      expect(query.tags.none).toEqual(['b']);
      expect(query.text.any).toEqual(['x']);
      expect(query.text.none).toEqual(['y']);
      expect(query.note.all).toEqual(['n']);
      expect(query.note.any).toEqual(['m']);
    });

    // Words are compared directly by the read layer, so normalizing on the way in
    // is what makes `?text=Hello` and `?text=hello` the same search. Ids are NOT
    // normalized — they are opaque and case-significant.
    it('lowercases and trims search words, and drops empty ones', () => {
      const { query } = mountAt('text=%20HeLLo%20&text=&text=%20%20&url=EXAMPLE.com');
      expect(query.text.all).toEqual(['hello']);
      expect(query.url.all).toEqual(['example.com']);
    });

    it('keeps list and tag ids verbatim', () => {
      const { query } = mountAt('list=List-AbC&tag=%20Tag-1');
      expect(query.lists.any).toEqual(['List-AbC']);
      expect(query.tags.any).toEqual([' Tag-1']);
    });

    describe('the sort override', () => {
      it('falls back to the synced setting when the URL says nothing', () => {
        mockSetting = { sortOn: 'createdAt', sortOrder: 'asc' };
        const { query } = mountAt('list=list-abc');
        expect(query.sortOn).toBe('createdAt');
        expect(query.sortOrder).toBe('asc');
      });

      it('lets a hand-typed URL win over the setting', () => {
        mockSetting = { sortOn: 'updatedAt', sortOrder: 'desc' };
        const { query } = mountAt('list=list-abc&sort=createdAt&order=asc');
        expect(query.sortOn).toBe('createdAt');
        expect(query.sortOrder).toBe('asc');
      });

      // A value this build doesn't know is not an error and not a crash — it is
      // simply not an override, so the setting still applies.
      it('ignores a sort value it does not recognize', () => {
        mockSetting = { sortOn: 'createdAt', sortOrder: 'asc' };
        const { query } = mountAt('sort=whatever&order=sideways');
        expect(query.sortOn).toBe('createdAt');
        expect(query.sortOrder).toBe('asc');
      });

      // The setting arrives as a tolerant `string` from the synced store, so a
      // value written by a newer build (or corrupted) must not reach the read
      // layer as a sort field it has no index for.
      it('coerces a setting value it does not recognize', () => {
        mockSetting = { sortOn: 'nonsense', sortOrder: 'nonsense' };
        const { query } = mountAt('');
        expect(query.sortOn).toBe('updatedAt');
        expect(query.sortOrder).toBe('desc');
      });
    });

    // useLinks keys a liveQuery and its staged repaint on this reference, so a
    // query rebuilt on every render would re-run the read continuously.
    it('holds the query reference still across re-renders of the same URL', () => {
      const { query: first } = mountAt('list=list-abc');
      const before = api.query;
      act(() => api.setSimpleQuery({ kind: 'list', id: 'list-abc' }));
      expect(api.query).toBe(before);
      expect(api.query).toBe(first);
    });
  });

  describe('the selection projection', () => {
    it.each<[string, string, Selection]>([
      ['a single list', 'list=list-abc', { kind: 'list', id: 'list-abc' }],
      ['a single tag', 'tag=tag-1', { kind: 'tag', id: 'tag-1' }],
      ['show all', `list=${ALL_ID}`, { kind: 'all' }],
    ])('points the sidebar at %s', (_label, search, expected) => {
      expect(mountAt(search).selection).toEqual(expected);
    });

    // Everything the sidebar has no single row to highlight. The failure this
    // guards is a STALE highlight: a global search that still lights up whichever
    // list happened to be in the URL, so the rail disagrees with the pane.
    it.each([
      ['a basic text search', 'text=hello'],
      ['a field-scoped search', 'title=doc'],
      ['a note search', 'note=todo'],
      ['a text search inside a single list', 'list=list-abc&text=hello'],
      ['two lists at once', 'list=a&list=b'],
      ['a list and a tag together', 'list=a&tag=b'],
      ['an exclusion', `list=${ALL_ID}&list-none=trash`],
      ['a tag-all conjunction', 'tag-all=a&tag-all=b'],
      ['a tag exclusion', 'tag-none=a'],
    ])('highlights nothing for %s', (_label, search) => {
      expect(mountAt(search).selection).toEqual({ kind: 'none' });
    });
  });

  describe('writing the URL', () => {
    it('writes the canonical clean URL for each simple selection', () => {
      const { setSimpleQuery } = mountAt('');
      const href = (selection: Selection) => {
        push.mockClear();
        act(() => setSimpleQuery(selection));
        return push.mock.calls[0][0];
      };

      // The default inbox is the bare `/links` — the page's home carries no query
      // noise, and parsing it back re-injects My List.
      expect(href({ kind: 'list', id: DEFAULT_LIST_ID })).toBe('/links');
      expect(href({ kind: 'all' })).toBe(`/links?list=${ALL_ID}`);
      expect(href({ kind: 'list', id: 'list-abc' })).toBe('/links?list=list-abc');
      expect(href({ kind: 'tag', id: 'tag-1' })).toBe('/links?tag=tag-1');
      // No target axis → home, rather than an unparseable URL.
      expect(href({ kind: 'none' })).toBe('/links');
    });

    it('percent-encodes an id so a token with URL syntax in it survives', () => {
      const { setSimpleQuery } = mountAt('');
      act(() => setSimpleQuery({ kind: 'tag', id: 'a&b=c' }));
      expect(push).toHaveBeenCalledWith('/links?tag=a%26b%3Dc');
    });

    // push, not replace: the views you visit are history, which is the whole
    // reason the view lives in the URL.
    it('pushes rather than replaces, so Back steps through the views visited', () => {
      const { setSimpleQuery } = mountAt('');
      act(() => setSimpleQuery({ kind: 'list', id: 'list-abc' }));
      expect(push).toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
    });

    it('collapses an emptied search back to home', () => {
      expect(serialize(emptyQuery())).toBe('/links');
    });

    it('emits repeated keys, never a comma or a plus', () => {
      const query = emptyQuery();
      query.tags.any = ['a', 'b'];
      const href = serialize(query);
      expect(href).toBe('/links?tag=a&tag=b');
      expect(href).not.toContain(',');
    });

    // A hand-typed `?sort=` is a read-only override, so committing a search must
    // drop it rather than bake it into the URL the setter writes.
    it('never serializes the sort back into the URL', () => {
      const query = emptyQuery();
      query.text.all = ['hello'];
      query.sortOn = 'createdAt';
      query.sortOrder = 'asc';
      const href = serialize(query);
      expect(href).toBe('/links?text=hello');
      expect(href).not.toContain('sort');
      expect(href).not.toContain('order');
    });
  });

  // The property neither half can hold alone: the serializer's spelling has to be
  // one the parser reads back the same way. A drift here is invisible until the
  // user presses Back onto their own committed search.
  describe('round-tripping a query through the URL', () => {
    it.each<[string, (q: LinkQuery) => void]>([
      ['a multi-tag include', (q) => void (q.tags.any = ['tag-1', 'tag-2'])],
      ['a tag conjunction', (q) => void (q.tags.all = ['tag-1', 'tag-2'])],
      ['a tag exclusion', (q) => void (q.tags.none = ['tag-1'])],
      ['a list exclusion', (q) => void (q.lists.none = ['trash'])],
      ['basic search words', (q) => void (q.text.all = ['hello', 'world'])],
      ['an any-of search', (q) => void (q.text.any = ['hello', 'world'])],
      ['an excluded word', (q) => void (q.text.none = ['spam'])],
      ['a url clause', (q) => void (q.url.all = ['example.com'])],
      ['a title clause', (q) => void (q.title.none = ['draft'])],
      ['a note clause', (q) => void (q.note.any = ['todo'])],
      [
        'a compound search',
        (q) => {
          q.lists.any = ['list-abc'];
          q.tags.all = ['tag-1', 'tag-2'];
          q.tags.none = ['tag-3'];
          q.text.all = ['hello'];
          q.note.none = ['done'];
        },
      ],
    ])('reads back %s exactly as committed', (_label, build) => {
      const committed = emptyQuery();
      build(committed);

      const href = serialize(committed);
      const parsed = mountAt(href.slice(href.indexOf('?') + 1)).query;

      expect(parsed).toEqual(committed);
    });
  });

  describe('remembering the view for Settings', () => {
    it('records the bare home for an unfiltered view', () => {
      mountAt('');
      expect(recordLinksReturn).toHaveBeenCalledWith('/links');
    });

    it('records the live URL, so the ✕ returns to the view on screen', () => {
      mountAt('list=list-abc&text=hello');
      expect(recordLinksReturn).toHaveBeenCalledWith('/links?list=list-abc&text=hello');
    });
  });

  describe('a selection whose entity is gone', () => {
    it('sends a deleted list home, by replace so Back cannot return to it', () => {
      mockLists = [node('list-other')];
      mountAt('list=list-deleted');
      expect(replace).toHaveBeenCalledWith('/links');
      expect(push).not.toHaveBeenCalled();
    });

    it('sends a deleted tag home', () => {
      mockTags = [node('tag-other')];
      mountAt('tag=tag-deleted');
      expect(replace).toHaveBeenCalledWith('/links');
    });

    it('finds an id nested anywhere in the tree', () => {
      mockLists = [node('parent', [node('deep')])];
      mountAt('list=deep');
      expect(replace).not.toHaveBeenCalled();
    });

    // The half that makes this safe to run continuously. An empty tree is what
    // "still loading" and "the last one was deleted" both look like, so it never
    // convicts — otherwise every cold load of a shared list URL would bounce to
    // the inbox before the store answered.
    it('never convicts on an empty tree', () => {
      mockLists = [];
      mockTags = [];
      mountAt('list=list-abc');
      expect(replace).not.toHaveBeenCalled();
    });

    // A compound query may name a deleted id among several live clauses; dropping
    // the whole search over one of them throws away far more than it fixes.
    it('leaves a compound query alone even when it names a dead id', () => {
      mockLists = [node('list-other')];
      mockTags = [node('tag-other')];
      mountAt('list=list-deleted&text=hello');
      expect(replace).not.toHaveBeenCalled();
    });
  });

  it('refuses to be read outside its provider', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/must be used within a LinksPageProvider/);
    errorSpy.mockRestore();
  });
});

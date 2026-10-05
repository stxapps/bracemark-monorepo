// The links page's URL edge, driven through a REAL expo-router tree: does a
// navigation actually reach `query`?
//
// This is the one thing about this provider no other layer can see. It reads
// route params from a component that the links _LAYOUT_ renders, one level above
// the route those params land on, and both of expo-router's param hooks return a
// plausible bag there — the local one just returns the layout's own (empty, and
// permanently empty) params instead of the view's. Nothing lints it, nothing
// types it, and the rendered result is a screen that quietly never changes: the
// drawer's list never opens, a committed search never filters, because `query`
// never moves and the read edge (use-links) has nothing to re-run. So the spec
// has to be a routed one — a rendered provider handed a params object proves
// nothing about what a `router.push` puts in it.
//
// It pins three things: a navigation lands in `query`, a params bag REPLACES the
// previous one rather than merging into it (`/links` clears a `?tag=`), and
// `query`'s identity is stable per view and holds while another screen is
// focused — the two properties use-links keys its live read and its staged
// repaint on.
//
// And a fourth that only a routed tree can stage: a list DELETED from Settings
// while this provider sits mounted underneath. The view has to be home in the
// render that learns of it, and the navigation that brings the URL into line
// has to wait for Settings to leave — `replace` acts on the focused card.
//
// The drawer here is a stand-in, not the real `expo-router/drawer`: that one
// needs a live gesture-handler/reanimated surface this runner doesn't have (see
// src/testing/setup.ts's stub). It's built on the real `DrawerRouter`, though,
// and both halves of that matter — expo-router demotes a `push` to a navigate
// against any non-stack navigator, which is how the params come to land one
// level below this provider in the first place, and it demotes a `replace` only
// against a navigator whose state says `type: 'drawer'`. On a bare `TabRouter`
// the stale-selection `replace` is an action nothing handles, and the URL never
// moves.

import { Text } from 'react-native';
import {
  createNavigatorFactory,
  type DrawerNavigationState,
  DrawerRouter,
  type ParamListBase,
  useNavigationBuilder,
} from '@react-navigation/native';
import { router, Stack, withLayoutContext } from 'expo-router';
import { act, renderRouter, screen } from 'expo-router/testing-library';

import { useLists } from '@stxapps/expo-react';
import type { LinkQuery, TreeItem, TreeNode } from '@stxapps/shared';
import { DEFAULT_LIST_ID } from '@stxapps/shared';

import { LinksPageProvider, type Selection, useLinksPage } from './page-provider';

// The provider's three data reads. `useLists`/`useTags` feed the stale-selection
// fallback only, and an EMPTY tree is never taken as proof an id is gone (see
// the provider), so `[]` keeps it quiet and the specs above it on the URL. The
// list tree is a subscribable value rather than a constant so that a spec can
// delete a list under a MOUNTED provider, the way the live read delivers it.
let mockLists: TreeNode<TreeItem>[] = [];
const mockNoTags: TreeNode<TreeItem>[] = [];
const mockListListeners = new Set<() => void>();
jest.mock('@stxapps/expo-react', () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import('react')>('react');
  const subscribe = (listener: () => void) => {
    mockListListeners.add(listener);
    return () => void mockListListeners.delete(listener);
  };
  return {
    useLists: () => useSyncExternalStore(subscribe, () => mockLists),
    useTags: () => mockNoTags,
    useSettings: () => ({ sortOn: 'addedDT', sortOrder: 'desc' }),
  };
});

const setLists = (next: TreeNode<TreeItem>[]) =>
  act(() => {
    mockLists = next;
    for (const listener of mockListListeners) listener();
  });

function MiniDrawerNavigator(props: Parameters<typeof useNavigationBuilder>[1]) {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(DrawerRouter, props);
  return (
    <NavigationContent>{descriptors[state.routes[state.index].key].render()}</NavigationContent>
  );
}
// `EventMapBase` itself isn't re-exported from @react-navigation/native, so the
// event map is spelled out; this navigator emits nothing of its own anyway.
type MiniDrawerEvents = Record<string, { data?: unknown; canPreventDefault?: boolean }>;
const MiniDrawer = withLayoutContext<
  object,
  typeof MiniDrawerNavigator,
  DrawerNavigationState<ParamListBase>,
  MiniDrawerEvents
>(createNavigatorFactory(MiniDrawerNavigator)().Navigator);

// Every render of the provider's subtree, newest last. A render log rather than
// a rendered value because the freeze assertion runs while ANOTHER screen is
// focused: the layout keeps rendering (that IS the thing under test), but this
// runner's stack drops the covered card's output, so `screen` can't be queried
// for it.
const renders: { query: LinkQuery; selection: Selection }[] = [];

function Probe() {
  const { query, selection } = useLinksPage();
  // Subscribed to the tree as well, the way the topbar is: a deleted list then
  // re-renders this whether or not the provider's context moved, which is the
  // render a consumer would paint the dead view in.
  useLists();
  renders.push({ query, selection });
  return <Text testID="probe">links</Text>;
}

function LinksLayout() {
  return (
    <LinksPageProvider>
      <Probe />
      <MiniDrawer />
    </LinksPageProvider>
  );
}

function mountLinks() {
  renders.length = 0;
  mockLists = [];
  const routed = renderRouter(
    {
      '(app)/_layout': () => <Stack screenOptions={{ headerShown: false }} />,
      '(app)/links/_layout': LinksLayout,
      '(app)/links/index': () => <Text>links screen</Text>,
      '(app)/settings/[section]': () => <Text>settings screen</Text>,
    },
    { initialUrl: '/links' },
  );
  expect(screen.getByTestId('probe')).toBeTruthy();
  // The URL getters are typed on this result, not on `screen`.
  return routed;
}

// The provider's current view, off the render log.
const current = () => renders[renders.length - 1];

const go = (href: string) => act(() => router.push(href));

describe('LinksPageProvider', () => {
  it('starts on the default inbox when the URL carries no filter', () => {
    mountLinks();
    expect(current().query.lists.any).toEqual([DEFAULT_LIST_ID]);
    expect(current().selection).toEqual({ kind: 'list', id: DEFAULT_LIST_ID });
  });

  it('follows a drawer pick, and a later pick REPLACES the earlier filter', () => {
    mountLinks();

    go('/links?list=list-abc');
    expect(current().query.lists.any).toEqual(['list-abc']);
    expect(current().selection).toEqual({ kind: 'list', id: 'list-abc' });

    // Not `{list, tag}`: the whole params bag is rewritten, so the previous
    // axis is gone rather than ANDed onto this one.
    go('/links?tag=tag-zzz');
    expect(current().query.lists.any).toEqual([]);
    expect(current().query.tags.any).toEqual(['tag-zzz']);
    expect(current().selection).toEqual({ kind: 'tag', id: 'tag-zzz' });

    // …and back to the bare href, which is the default inbox again — the case a
    // merge would strand on the old tag forever.
    go('/links');
    expect(current().query.lists.any).toEqual([DEFAULT_LIST_ID]);
    expect(current().query.tags.any).toEqual([]);
  });

  it('follows a committed search, words normalized and repeated keys ANDed', () => {
    mountLinks();

    go('/links?text=Alpha&text=Beta');
    expect(current().query.text.all).toEqual(['alpha', 'beta']);
    // A text query has no single-axis surface — what force-shows the search bar.
    expect(current().selection).toEqual({ kind: 'none' });

    go('/links?list=list-abc&tag=tag-zzz');
    expect(current().query.text.all).toEqual([]);
    expect(current().query.lists.any).toEqual(['list-abc']);
    expect(current().query.tags.any).toEqual(['tag-zzz']);
  });

  it('holds one query identity per view — a re-render is not a new page', () => {
    mountLinks();
    go('/links?list=list-abc');
    const settled = current().query;

    // Same href again: the params bag is identical, so the view didn't change.
    go('/links?list=list-abc');
    expect(current().query).toBe(settled);
  });

  it('freezes the view while another screen is focused, and restores it', () => {
    mountLinks();
    go('/links?text=Alpha');
    const settled = current().query;

    // Settings is a sibling card in the `(app)` stack: this provider stays
    // MOUNTED under it, so an ungated global read would swing onto settings'
    // own params here, parse the no-filter default out of them, and drop the
    // search the user is coming back to.
    go('/settings/general');
    expect(current().query).toBe(settled);

    // Coming back is the same object, not merely the same view: nothing in
    // use-links re-runs, so the list is still scrolled where it was left.
    act(() => router.dismiss());
    expect(current().query).toBe(settled);
  });

  describe('a selection whose list was deleted', () => {
    const node = (id: string): TreeNode<TreeItem> => ({
      item: { id, parentId: null, rank: 'a' },
      depth: 0,
      children: [],
    });
    // The inbox is in both trees, as it always is once the store answers (the
    // system lists are merged in) — a tree without it would convict home too.
    const before = [node(DEFAULT_LIST_ID), node('list-abc')];
    const after = [node(DEFAULT_LIST_ID)];
    const home: Selection = { kind: 'list', id: DEFAULT_LIST_ID };

    it('is home in the render that learns of it, and the URL follows', () => {
      const routed = mountLinks();
      setLists(before);
      go('/links?list=list-abc');
      // A list the tree still holds is left exactly where the URL put it.
      expect(current().selection).toEqual({ kind: 'list', id: 'list-abc' });

      const mark = renders.length;
      setLists(after);
      const since = renders.slice(mark);
      expect(since.length).toBeGreaterThan(0);

      // EVERY render since, not the last: the failure is the dead view being
      // shown until the navigation comes back around — an unnamed topbar over
      // an empty list — which a look at the settled state can't see.
      for (const render of since) expect(render.selection).toEqual(home);
      expect(current().query.lists.any).toEqual([DEFAULT_LIST_ID]);
      // …and ONE query object across the fallback and the URL that catches up
      // with it: they are the same view, so use-links must not re-run.
      expect(new Set(since.map((render) => render.query)).size).toBe(1);

      expect(routed.getPathnameWithParams()).toBe('/links');
    });

    it('shows home at once under Settings, but navigates only when it closes', () => {
      const routed = mountLinks();
      setLists(before);
      go('/links?list=list-abc');
      go('/settings/lists');

      setLists(after);
      expect(current().selection).toEqual(home);
      // `replace` acts on the focused card. Ungated, it would have swapped
      // Settings out from under the user who just pressed Delete in it.
      expect(routed.getPathname()).toBe('/settings/lists');

      act(() => router.dismiss());
      expect(routed.getPathnameWithParams()).toBe('/links');
      expect(current().selection).toEqual(home);
    });
  });
});

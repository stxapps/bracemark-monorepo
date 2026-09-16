import * as React from 'react';
import { act, render } from '@testing-library/react-native';

import type { LinkView } from '@stxapps/expo-react';
import { DEFAULT_LIST_ID, type LinkQuery } from '@stxapps/shared';

import type { Selection } from './page-provider';
import {
  LinksViewStateProvider,
  useLinksViewActions,
  useLinksViewState,
} from './view-state-provider';

let mockQuery: LinkQuery = {} as LinkQuery;
let mockSelection: Selection = { kind: 'all' };
const mockSetSimpleQuery = jest.fn();

jest.mock('./page-provider', () => ({
  useLinksPage: () => ({
    query: mockQuery,
    selection: mockSelection,
    setSimpleQuery: mockSetSimpleQuery,
  }),
}));

const link = (path: string) => ({ path, id: path }) as unknown as LinkView;
const A = link('a');
const B = link('b');
const C = link('c');
const ROWS = [A, B, C];

let api: ReturnType<typeof useLinksViewState>;

function Probe() {
  api = useLinksViewState();
  return null;
}

function mount() {
  const view = render(
    <LinksViewStateProvider>
      <Probe />
    </LinksViewStateProvider>,
  );
  return {
    ...view,
    rerenderPage: () =>
      view.rerender(
        <LinksViewStateProvider>
          <Probe />
        </LinksViewStateProvider>,
      ),
  };
}

const selectedPaths = () => [...api.selectedLinks.keys()].sort();

beforeEach(() => {
  mockQuery = { lists: { any: [], none: [] } } as unknown as LinkQuery;
  mockSelection = { kind: 'all' };
  mockSetSimpleQuery.mockClear();
});

describe('engagement', () => {
  test('starts idle and returns to idle when scrolling returns to the top', () => {
    mount();
    expect(api.engaged).toBe(false);

    act(() => api.setScrolled(true));
    expect(api.engaged).toBe(true);

    act(() => api.setScrolled(false));
    expect(api.engaged).toBe(false);
  });

  test.each<[string, () => void]>([
    ['a row overlay is open', () => api.setMenuOpen(true)],
    ['a permanent delete is being confirmed', () => api.requestDestroy([A])],
    ['the bulk tags dialog is open', () => api.requestRetag([A])],
    ['bulk edit is active', () => api.enterBulkEdit()],
  ])('holds background results while %s', (_label, engage) => {
    mount();
    act(engage);

    expect(api.engaged).toBe(true);
  });

  test('stays engaged until every open overlay has closed', () => {
    mount();
    act(() => api.setMenuOpen(true));
    act(() => api.setMenuOpen(true));
    act(() => api.setMenuOpen(false));
    expect(api.engaged).toBe(true);

    act(() => api.setMenuOpen(false));
    expect(api.engaged).toBe(false);
  });

  test('does not bank negative overlay counts from stray closes', () => {
    mount();
    act(() => api.setMenuOpen(false));
    act(() => api.setMenuOpen(false));
    expect(api.engaged).toBe(false);

    act(() => api.setMenuOpen(true));
    expect(api.engaged).toBe(true);
  });
});

test.each<[string, () => void, () => unknown]>([
  ['destroy', () => api.requestDestroy([]), () => api.destroying],
  ['retag', () => api.requestRetag([]), () => api.retagging],
])('ignores an empty %s request', (_label, request, read) => {
  mount();
  act(request);

  expect(read()).toBeNull();
  expect(api.engaged).toBe(false);
});

describe('search visibility', () => {
  test('shows when explicitly opened', () => {
    mount();
    expect(api.searchVisible).toBe(false);

    act(() => api.setSearchOpen(true));
    expect(api.searchVisible).toBe(true);
  });

  test('force-shows for a committed search with no simple selection', () => {
    mockSelection = { kind: 'none' };
    mount();

    expect(api.searchOpen).toBe(false);
    expect(api.searchVisible).toBe(true);
  });

  test('stays open when an advanced search still projects to one list', () => {
    const { rerenderPage } = mount();
    act(() => api.setSearchOpen(true));

    mockSelection = { kind: 'list', id: 'reading' };
    act(rerenderPage);

    expect(api.searchVisible).toBe(true);
  });
});

// Every exit from a committed search runs `restorePreSearch` — the topbar's
// toggle, Android back, the box's ✕, and Enter on an emptied box. What it must
// never do is what the ✕ used to: commit an empty query, which silently moved
// the user to My List and left the view they were on reachable only by
// re-navigating the drawer (the search is simple again, so the toggle no longer
// has one to leave).
describe('leaving a search', () => {
  const search = (rerenderPage: () => void) => {
    mockSelection = { kind: 'none' };
    act(rerenderPage);
  };

  test('returns to the view the search was run from', () => {
    mockSelection = { kind: 'tag', id: 'rust' };
    const { rerenderPage } = mount();
    search(rerenderPage);

    act(() => api.restorePreSearch());

    expect(mockSetSimpleQuery).toHaveBeenCalledWith({ kind: 'tag', id: 'rust' });
  });

  // The bar force-shows for a committed search nobody opened it for (a back
  // gesture into a `?text=` URL), so the restore target cannot come from the
  // toggle — it is tracked as the views go by.
  test('remembers a view the search bar was never opened over', () => {
    mockSelection = { kind: 'list', id: 'reading' };
    const { rerenderPage } = mount();
    search(rerenderPage);

    act(() => api.restorePreSearch());

    expect(mockSetSimpleQuery).toHaveBeenCalledWith({ kind: 'list', id: 'reading' });
  });

  test('holds the remembered view for the whole search, not just its first frame', () => {
    mockSelection = { kind: 'list', id: 'reading' };
    const { rerenderPage } = mount();
    search(rerenderPage);
    act(rerenderPage);
    act(rerenderPage);

    act(() => api.restorePreSearch());

    expect(mockSetSimpleQuery).toHaveBeenCalledWith({ kind: 'list', id: 'reading' });
  });

  // A cold mount straight into a search URL: there is no earlier view, so the
  // default inbox is the only honest destination.
  test('falls back to the default inbox with no earlier view to return to', () => {
    mockSelection = { kind: 'none' };
    mount();

    act(() => api.restorePreSearch());

    expect(mockSetSimpleQuery).toHaveBeenCalledWith({ kind: 'list', id: DEFAULT_LIST_ID });
  });

  // Typing into the box over a plain list view and clearing it again commits
  // nothing — so it must not navigate either.
  test('does nothing when no search is committed', () => {
    mockSelection = { kind: 'list', id: 'reading' };
    mount();

    act(() => api.restorePreSearch());

    expect(mockSetSimpleQuery).not.toHaveBeenCalled();
  });
});

describe('bulk edit', () => {
  test('toggles a link in and back out of the selection', () => {
    mount();
    act(() => api.enterBulkEdit());
    act(() => api.toggleSelected(A));
    expect(selectedPaths()).toEqual(['a']);

    act(() => api.toggleSelected(A));
    expect(selectedPaths()).toEqual([]);
  });

  test('selects and clears the displayed set without exiting the mode', () => {
    mount();
    act(() => api.enterBulkEdit());
    act(() => api.toggleSelected(A));
    act(() => api.selectAll(ROWS));
    expect(selectedPaths()).toEqual(['a', 'b', 'c']);

    act(() => api.clearSelected());
    expect(selectedPaths()).toEqual([]);
    expect(api.bulkEditing).toBe(true);
  });

  test('clears the selected snapshots when the mode exits', () => {
    mount();
    act(() => api.enterBulkEdit());
    act(() => api.toggleSelected(A));
    act(() => api.exitBulkEdit());

    expect(api.bulkEditing).toBe(false);
    expect(selectedPaths()).toEqual([]);
  });

  test('exits and clears when navigation changes the page query', () => {
    const { rerenderPage } = mount();
    act(() => api.enterBulkEdit());
    act(() => api.toggleSelected(A));

    mockQuery = { lists: { any: ['other'], none: [] } } as unknown as LinkQuery;
    act(rerenderPage);

    expect(api.bulkEditing).toBe(false);
    expect(selectedPaths()).toEqual([]);
  });

  test('survives an ordinary rerender of the same page', () => {
    const { rerenderPage } = mount();
    act(() => api.enterBulkEdit());
    act(() => api.toggleSelected(A));
    act(rerenderPage);

    expect(api.bulkEditing).toBe(true);
    expect(selectedPaths()).toEqual(['a']);
  });
});

test.each([
  ['useLinksViewState', () => useLinksViewState()],
  ['useLinksViewActions', () => useLinksViewActions()],
])('%s rejects reads outside its provider', (_name, useHook) => {
  function OutsideProbe() {
    useHook();
    return null;
  }
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  expect(() => render(<OutsideProbe />)).toThrow(/must be used within a LinksViewStateProvider/);

  errorSpy.mockRestore();
});

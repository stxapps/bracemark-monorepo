import * as React from 'react';
import { act, render } from '@testing-library/react-native';

import type { LinkView } from '@stxapps/expo-react';
import type { LinkQuery } from '@stxapps/shared';

import type { Selection } from './page-provider';
import {
  LinksViewStateProvider,
  useLinksViewActions,
  useLinksViewState,
} from './view-state-provider';

let mockQuery: LinkQuery = {} as LinkQuery;
let mockSelection: Selection = { kind: 'all' };

jest.mock('./page-provider', () => ({
  useLinksPage: () => ({ query: mockQuery, selection: mockSelection }),
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

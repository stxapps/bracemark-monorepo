/**
 * @jest-environment jsdom
 */
// The links list is index-virtualized and sorted newest-first, so `engaged` is
// what stands between a background sync and the rows moving under the user's
// hand. Both directions of getting it wrong are silent: stuck TRUE and the list
// never repaints again — every sync piles up behind the refresh pill on a page
// nobody is touching — while stuck FALSE means a touched link floats to the top
// mid-multi-select, or a row menu's trigger unmounts while it is open.
//
// The two places it can stick are the ones with arithmetic in them:
//
//   - `openMenus` is a COUNT, because one overlay opening as another closes must
//     not zero the flag; the `Math.max(0, …)` floor is what stops a stray close
//     from banking a negative that then swallows a real open.
//   - bulk-edit's selection and its shift-click ANCHOR are two pieces of state
//     that have to agree. The anchor is a ref, so nothing re-renders when it
//     drifts, and a range extended from a stale anchor selects rows the user
//     never dragged over.
//
// Everything else here is the rule that a request with nothing in it is not a
// request (an empty `requestMove` would open an empty picker), the derived
// `searchVisible` the topbar toggle and the search row must not disagree about,
// and the one cross-provider rule: navigating to another view exits bulk-edit,
// so a selection made in one view can never be acted on from another — where
// Remove and Delete-permanently mean different things.

import { act, render } from '@testing-library/react';

import { DEFAULT_LIST_ID, type LinkQuery } from '@stxapps/shared';
import type { LinkView } from '@stxapps/web-react';

import type { Selection } from './page-provider';
import { LinksViewStateProvider, useLinksViewState } from './view-state-provider';

let mockQuery: LinkQuery = {} as LinkQuery;
let mockSelection: Selection = { kind: 'all' };
let mockWide = true;
const mockSetSimpleQuery = jest.fn();

jest.mock('./page-provider', () => ({
  useLinksPage: () => ({
    query: mockQuery,
    selection: mockSelection,
    setSimpleQuery: mockSetSimpleQuery,
  }),
}));

jest.mock('@stxapps/web-ui/hooks/use-media-query', () => ({
  MD_QUERY: '(min-width: 48rem)',
  useMediaQuery: () => mockWide,
}));

const link = (path: string) => ({ path, id: path }) as unknown as LinkView;

const A = link('a');
const B = link('b');
const C = link('c');
const D = link('d');
const ROWS = [A, B, C, D];

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
    // Re-render with whatever the module-level page state now says — how a
    // navigation reaches this provider.
    rerenderPage: () =>
      view.rerender(
        <LinksViewStateProvider>
          <Probe />
        </LinksViewStateProvider>,
      ),
  };
}

// The selected rows in a shape that is readable in a failure message.
const selectedPaths = () => [...api.selectedLinks.keys()].sort();

describe('LinksViewStateProvider', () => {
  beforeEach(() => {
    mockQuery = { lists: { any: [], none: [] } } as unknown as LinkQuery;
    mockSelection = { kind: 'all' };
    mockWide = true;
    mockSetSimpleQuery.mockClear();
  });

  describe('engaged — when a repaint would disrupt the user', () => {
    it('is idle on a fresh, unscrolled view', () => {
      mount();
      expect(api.engaged).toBe(false);
    });

    it.each<[string, () => void]>([
      ['the pane is scrolled away from the top', () => api.setScrolled(true)],
      ['a row menu is open', () => api.setMenuOpen(true)],
      ['the edit dialog is up', () => api.openEditor(A)],
      ['a permanent delete is being confirmed', () => api.requestDestroy([A])],
      ['the bulk tags dialog is up', () => api.requestRetag([A])],
      ['a move-to picker is up', () => api.requestMove([A])],
      ['bulk-edit mode is on', () => api.enterBulkEdit()],
    ])('holds results back while %s', (_label, engage) => {
      mount();
      act(engage);
      expect(api.engaged).toBe(true);
    });

    it('goes idle again once the user scrolls back to the top', () => {
      mount();
      act(() => api.setScrolled(true));
      act(() => api.setScrolled(false));
      expect(api.engaged).toBe(false);
    });
  });

  describe('the open-overlay count', () => {
    it('stays engaged while one of two overlays is still open', () => {
      mount();
      act(() => api.setMenuOpen(true));
      act(() => api.setMenuOpen(true));
      act(() => api.setMenuOpen(false));
      expect(api.engaged).toBe(true);

      act(() => api.setMenuOpen(false));
      expect(api.engaged).toBe(false);
    });

    // The floor. Without it a stray close banks -1, and the next real open only
    // brings the count back to 0 — so an open menu no longer holds the list still.
    it('cannot be driven negative by a close with nothing open', () => {
      mount();
      act(() => api.setMenuOpen(false));
      act(() => api.setMenuOpen(false));
      expect(api.engaged).toBe(false);

      act(() => api.setMenuOpen(true));
      expect(api.engaged).toBe(true);
    });
  });

  describe('the hoisted dialogs', () => {
    it('carries the requested focus target into the editor', () => {
      mount();
      act(() => api.openEditor(A, 'note'));
      expect(api.editing).toEqual({ link: A, focus: 'note' });

      act(() => api.closeEditor());
      expect(api.editing).toBeNull();
    });

    // A non-null request always has at least one link, which is what lets the
    // dialogs render `links[0]` without a guard.
    it.each<[string, () => void, () => unknown]>([
      ['destroy', () => api.requestDestroy([]), () => api.destroying],
      ['retag', () => api.requestRetag([]), () => api.retagging],
      ['move', () => api.requestMove([]), () => api.moving],
    ])('ignores an empty %s request', (_label, request, read) => {
      mount();
      act(request);
      expect(read()).toBeNull();
      expect(api.engaged).toBe(false);
    });
  });

  describe('the narrow-width search row', () => {
    it('shows when the user summons it', () => {
      mount();
      expect(api.searchVisible).toBe(false);
      act(() => api.setSearchOpen(true));
      expect(api.searchVisible).toBe(true);
    });

    // A committed search projects to `none`, which has no rail highlight and a
    // generic title — so the row is the only surface naming the view, and it must
    // show even on a Back into a `?text=` URL that nobody "opened".
    it('force-shows for a committed search the user never opened it for', () => {
      mockSelection = { kind: 'none' };
      mount();
      expect(api.searchOpen).toBe(false);
      expect(api.searchVisible).toBe(true);
    });

    // An advanced search over a single list projects to a SIMPLE selection, so
    // only the OR keeps the row alive across that commit.
    it('keeps the row up when a committed search resolves to a simple selection', () => {
      mount();
      act(() => api.setSearchOpen(true));
      mockSelection = { kind: 'list', id: 'list-abc' };
      expect(api.searchVisible).toBe(true);
    });
  });

  // Every exit from a committed search runs `restorePreSearch` — the topbar's
  // toggle below `md`, the box's ✕ and an emptied box at every width. What it
  // must never do is what the ✕ used to: commit an empty query, which silently
  // moved the user to My List and left the view they were on reachable only by
  // re-navigating the sidebar (the query is simple again, so the toggle no
  // longer has a search to leave).
  describe('leaving a search', () => {
    const search = (rerenderPage: () => void) => {
      mockSelection = { kind: 'none' };
      act(rerenderPage);
    };

    it('returns to the view the search was run from', () => {
      mockSelection = { kind: 'tag', id: 'tag-rust' };
      const { rerenderPage } = mount();
      search(rerenderPage);

      act(() => api.restorePreSearch());

      expect(mockSetSimpleQuery).toHaveBeenCalledWith({ kind: 'tag', id: 'tag-rust' });
    });

    // ABOVE `md` the box is persistent chrome and the search toggle never
    // renders, so a snapshot taken when the row is summoned would be null for
    // every desktop viewport — where the ✕ is the only exit there is.
    it('remembers a view the search row was never summoned over', () => {
      mockWide = true;
      mockSelection = { kind: 'list', id: 'list-abc' };
      const { rerenderPage } = mount();
      search(rerenderPage);

      act(() => api.restorePreSearch());

      expect(mockSetSimpleQuery).toHaveBeenCalledWith({ kind: 'list', id: 'list-abc' });
    });

    it('holds the remembered view for the whole search, not just its first frame', () => {
      mockSelection = { kind: 'list', id: 'list-abc' };
      const { rerenderPage } = mount();
      search(rerenderPage);
      act(rerenderPage);
      act(rerenderPage);

      act(() => api.restorePreSearch());

      expect(mockSetSimpleQuery).toHaveBeenCalledWith({ kind: 'list', id: 'list-abc' });
    });

    // A cold load straight into a search URL: there is no earlier view, so the
    // default inbox is the only honest destination.
    it('falls back to the default inbox with no earlier view to return to', () => {
      mockSelection = { kind: 'none' };
      mount();

      act(() => api.restorePreSearch());

      expect(mockSetSimpleQuery).toHaveBeenCalledWith({ kind: 'list', id: DEFAULT_LIST_ID });
    });

    // Typing into the box over a plain list view and clearing it again commits
    // nothing — so it must not navigate either.
    it('does nothing when no search is committed', () => {
      mockSelection = { kind: 'list', id: 'list-abc' };
      mount();

      act(() => api.restorePreSearch());

      expect(mockSetSimpleQuery).not.toHaveBeenCalled();
    });
  });

  describe('bulk edit', () => {
    it('toggles a row in and back out of the selection', () => {
      mount();
      act(() => api.enterBulkEdit());
      act(() => api.toggleSelected(A));
      expect(selectedPaths()).toEqual(['a']);

      act(() => api.toggleSelected(A));
      expect(selectedPaths()).toEqual([]);
    });

    it('clears the selection on the way out', () => {
      mount();
      act(() => api.enterBulkEdit());
      act(() => api.toggleSelected(A));
      act(() => api.exitBulkEdit());
      expect(api.bulkEditing).toBe(false);
      expect(selectedPaths()).toEqual([]);
    });

    it('replaces the selection wholesale for select-all, and clears it', () => {
      mount();
      act(() => api.enterBulkEdit());
      act(() => api.toggleSelected(D));
      act(() => api.selectAll(ROWS));
      expect(selectedPaths()).toEqual(['a', 'b', 'c', 'd']);

      act(() => api.clearSelected());
      expect(selectedPaths()).toEqual([]);
      expect(api.bulkEditing).toBe(true); // clearing is not leaving
    });

    describe('shift-click ranges', () => {
      it('selects everything between the anchor and the target, inclusive', () => {
        mount();
        act(() => api.toggleSelected(A));
        act(() => api.selectRange(C, ROWS));
        expect(selectedPaths()).toEqual(['a', 'b', 'c']);
      });

      it('works upward from the anchor too', () => {
        mount();
        act(() => api.toggleSelected(C));
        act(() => api.selectRange(A, ROWS));
        expect(selectedPaths()).toEqual(['a', 'b', 'c']);
      });

      it('falls back to a plain toggle when there is no anchor yet', () => {
        mount();
        act(() => api.selectRange(C, ROWS));
        expect(selectedPaths()).toEqual(['c']);
        // …and that toggle set the anchor, so the next range works.
        act(() => api.selectRange(A, ROWS));
        expect(selectedPaths()).toEqual(['a', 'b', 'c']);
      });

      // The anchor is a path, and the displayed page can shrink under it (a sync
      // landing, "show more" not yet pressed). A range against a vanished anchor
      // must not select from index 0.
      it('falls back to a plain toggle when the anchor is no longer displayed', () => {
        mount();
        act(() => api.toggleSelected(D));
        act(() => api.selectRange(B, [A, B, C]));
        expect(selectedPaths()).toEqual(['b', 'd']);
      });

      // Select-all is not a click, so it leaves no anchor behind. Inheriting the
      // one from before it turns the next shift-click into a no-op range over
      // rows that are already selected, instead of the deselect it looks like.
      it('does not inherit an anchor from select-all', () => {
        mount();
        act(() => api.toggleSelected(A));
        act(() => api.selectAll(ROWS));
        act(() => api.selectRange(C, ROWS));
        expect(selectedPaths()).toEqual(['a', 'b', 'd']);
      });
    });

    // Remove and Delete-permanently mean different things per view, so a
    // selection must never survive a navigation into another one.
    it('exits bulk-edit mode when the page navigates', () => {
      const { rerenderPage } = mount();
      act(() => api.enterBulkEdit());
      act(() => api.toggleSelected(A));

      mockQuery = { lists: { any: ['other'], none: [] } } as unknown as LinkQuery;
      act(rerenderPage);

      expect(api.bulkEditing).toBe(false);
      expect(selectedPaths()).toEqual([]);
    });

    // Keyed on the query's IDENTITY — the same stable reference useLinks reads —
    // so a re-render that changes nothing must not throw the selection away.
    it('survives a re-render that does not change the view', () => {
      const { rerenderPage } = mount();
      act(() => api.enterBulkEdit());
      act(() => api.toggleSelected(A));
      act(rerenderPage);

      expect(api.bulkEditing).toBe(true);
      expect(selectedPaths()).toEqual(['a']);
    });
  });

  it('refuses to be read outside its provider', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/must be used within a LinksViewStateProvider/);
    errorSpy.mockRestore();
  });
});

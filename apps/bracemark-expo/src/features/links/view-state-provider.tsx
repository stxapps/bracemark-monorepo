// Transient view state for the links screen that decides WHEN a background
// sync is allowed to repaint the list — the expo port of bracemark-web's
// `(app)/links/_contexts/view-state-provider.tsx` (canonical doc: the list is
// virtualized and newest-first, so applying a sync mid-interaction shifts rows
// under the user; the read edge holds results back while `engaged`).
//
// Ported so far: `scrolled` (the FlashList reports its scroll position left
// the top; applying at the top is harmless — newest-first feed — so we only
// guard once scrolled away), plus the bulk-edit trio: `bulkEditing` (the mode
// + its `selectedLinks` snapshot map, keyed by the stable `link.path` row
// key), `destroying` (the hoisted permanent-delete confirmation —
// LinkDestroyConfirm), `retagging` (the hoisted bulk "Edit tags" dialog —
// BulkTagsDialog), and `openMenus` (web's counter, verbatim: a row's options
// menu — or an overlay it spawned, the Move-to dialog / the chips' tag-overflow
// menu — is open; its trigger lives in a virtualized item, so a repaint could
// move or unmount it out from under the user. Counted, not a bool, so one
// opening as another closes can't leave it stuck — see shared.tsx
// useEngagedOpen). Web's remaining engagement signal (`editing`) is
// deliberately NOT ported: the editor here is a pushed modal screen
// (link-edit-screen.tsx), not a hoisted dialog — nothing row-anchored stays
// mounted under it, and its draft is a snapshot, so a repaint beneath the
// modal has nothing to disturb. Web's `selectRange` (shift-click) has no
// analogue on touch and is deliberately not ported.
//
// Like web, navigating to another view exits bulk-edit mode (watched off the
// page query's identity) — a selection made in one view can never be acted on
// from another (Remove and Delete-permanently mean different things per view).
//
// Also home to the search bar's chrome state. On web the search box is
// persistent topbar chrome; on this narrow screen it's summoned by the
// topbar's search toggle, which makes it the same kind of transient chrome
// state as `bulkEditing` (whose bottom bar it is mutually exclusive with —
// the search bar row hides while the mode is on, see search-bar.tsx). An OPEN
// bar is not an engagement signal: the list only changes when a search commits
// (a navigation), so a background repaint under the bar disturbs nothing.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { LinkView } from '@stxapps/expo-react';

import { type Selection, useLinksPage } from './page-provider';

// What `preSearch` may hold: a selection the drawer/topbar can render WITHOUT
// the search bar — everything but the 'none' projection. Narrowing the type
// (not just the writers) is what guarantees restoring a snapshot can never
// itself resolve `selection` to 'none' and force the bar back open.
export type SimpleSelection = Exclude<Selection, { kind: 'none' }>;

interface LinksViewStateValue {
  // True while a repaint would disrupt the user: scrolled past the top, a row
  // menu is open, a page-level dialog is up, or bulk-edit mode is on. useLinks
  // stages sync results while this holds.
  engaged: boolean;
  // The list's scroll position crossed (or returned to) the top.
  setScrolled: (scrolled: boolean) => void;
  // An item-anchored overlay (row menu, Move-to dialog, tag-overflow menu)
  // opened (true) or closed (false). Go through useEngagedOpen, not directly.
  setMenuOpen: (open: boolean) => void;
  // The user summoned the search bar row below the topbar (topbar's search
  // toggle). Explicit chrome INTENT, distinct from the rendered `searchVisible`
  // below — a committed search shows the bar with `searchOpen` false.
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  // The bar's rendered visibility — the single home for `searchOpen ||
  // selection.kind === 'none'` that both the topbar toggle and the bar itself
  // read, so they can't drift. The `none` disjunct is the one invariant the
  // query can express: a committed search that resolves `selection` to 'none'
  // has no other surface (no drawer highlight, generic title), so the bar
  // force-shows even when `searchOpen` is false (a back gesture into a `?text=`
  // URL). Only OR the two — the query alone can't decide it, since a
  // single-list/tag advanced search projects to a SIMPLE selection and the bar
  // must survive that commit. (Bulk-edit suppression is separate: the bar and
  // that mode share a slot, so search-bar hides on `bulkEditing` on top of this.)
  searchVisible: boolean;
  // Where the user was when the search bar was summoned — dismissing a
  // committed search returns here instead of home (topbar's toggle). Null when
  // the bar has never been opened, or was opened over a compound deep-link
  // view ('none' selection), which has no clean single-axis restore target.
  preSearch: SimpleSelection | null;
  setPreSearch: (selection: SimpleSelection | null) => void;
  // The permanent-delete confirmation: the links awaiting it (null = none; an
  // empty request is ignored, so a non-null value always has at least one).
  destroying: LinkView[] | null;
  requestDestroy: (links: LinkView[]) => void;
  closeDestroy: () => void;
  // The bulk "Edit tags" dialog: the links awaiting it (null = closed; an empty
  // request is ignored, so a non-null value always has at least one).
  retagging: LinkView[] | null;
  requestRetag: (links: LinkView[]) => void;
  closeRetag: () => void;
  // Bulk-edit mode: the ⋯ menu enters it, rows toggle selection while it's on,
  // the BulkEditBar acts on the selection. Exiting clears the selection.
  bulkEditing: boolean;
  enterBulkEdit: () => void;
  exitBulkEdit: () => void;
  // Row snapshots keyed by `link.path` (the row key). Snapshots may go stale
  // under a held-back sync, which is fine: the mutations re-read the current
  // blob before acting (see useLinkMutations.update/destroy).
  selectedLinks: ReadonlyMap<string, LinkView>;
  toggleSelected: (link: LinkView) => void;
  // Replace the selection with the given rows / clear it without leaving
  // bulk-edit mode — the two sides of the bar's Select-all checkbox.
  selectAll: (links: LinkView[]) => void;
  clearSelected: () => void;
}

const LinksViewStateContext = createContext<LinksViewStateValue | null>(null);

export function LinksViewStateProvider({ children }: { children: React.ReactNode }) {
  const [scrolled, setScrolled] = useState(false);
  const [openMenus, setOpenMenus] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [preSearch, setPreSearch] = useState<SimpleSelection | null>(null);
  const [destroying, setDestroying] = useState<LinkView[] | null>(null);
  const [retagging, setRetagging] = useState<LinkView[] | null>(null);
  const [bulkEditing, setBulkEditing] = useState(false);
  const [selectedLinks, setSelectedLinks] = useState<ReadonlyMap<string, LinkView>>(new Map());

  const setMenuOpen = useCallback((open: boolean) => {
    setOpenMenus((n) => Math.max(0, n + (open ? 1 : -1)));
  }, []);

  const requestDestroy = useCallback((links: LinkView[]) => {
    if (links.length > 0) setDestroying(links);
  }, []);
  const closeDestroy = useCallback(() => setDestroying(null), []);

  const requestRetag = useCallback((links: LinkView[]) => {
    if (links.length > 0) setRetagging(links);
  }, []);
  const closeRetag = useCallback(() => setRetagging(null), []);

  const enterBulkEdit = useCallback(() => setBulkEditing(true), []);
  const exitBulkEdit = useCallback(() => {
    setBulkEditing(false);
    setSelectedLinks(new Map());
  }, []);
  const toggleSelected = useCallback((link: LinkView) => {
    setSelectedLinks((prev) => {
      const next = new Map(prev);
      if (next.has(link.path)) next.delete(link.path);
      else next.set(link.path, link);
      return next;
    });
  }, []);
  const selectAll = useCallback((links: LinkView[]) => {
    setSelectedLinks(new Map(links.map((link) => [link.path, link])));
  }, []);
  const clearSelected = useCallback(() => {
    setSelectedLinks(new Map());
  }, []);

  // Navigating to another view (drawer press, back gesture, deep link) exits
  // bulk-edit mode — see the header comment. Keyed on the query's identity, the
  // same stable reference useLinks depends on. `selection` (same projection the
  // topbar/bar read) also feeds the derived `searchVisible` below.
  const { query, selection } = useLinksPage();
  const searchVisible = searchOpen || selection.kind === 'none';
  const prevQueryRef = useRef(query);
  useEffect(() => {
    if (prevQueryRef.current === query) return;
    prevQueryRef.current = query;
    exitBulkEdit();
  }, [query, exitBulkEdit]);

  const value = useMemo<LinksViewStateValue>(
    () => ({
      engaged:
        scrolled || openMenus > 0 || destroying !== null || retagging !== null || bulkEditing,
      setScrolled,
      setMenuOpen,
      searchOpen,
      setSearchOpen,
      searchVisible,
      preSearch,
      setPreSearch,
      destroying,
      requestDestroy,
      closeDestroy,
      retagging,
      requestRetag,
      closeRetag,
      bulkEditing,
      enterBulkEdit,
      exitBulkEdit,
      selectedLinks,
      toggleSelected,
      selectAll,
      clearSelected,
    }),
    [
      scrolled,
      openMenus,
      setMenuOpen,
      searchOpen,
      searchVisible,
      preSearch,
      destroying,
      requestDestroy,
      closeDestroy,
      retagging,
      requestRetag,
      closeRetag,
      bulkEditing,
      enterBulkEdit,
      exitBulkEdit,
      selectedLinks,
      toggleSelected,
      selectAll,
      clearSelected,
    ],
  );

  return <LinksViewStateContext.Provider value={value}>{children}</LinksViewStateContext.Provider>;
}

export function useLinksViewState(): LinksViewStateValue {
  const ctx = useContext(LinksViewStateContext);
  if (!ctx) {
    throw new Error('useLinksViewState must be used within a LinksViewStateProvider');
  }
  return ctx;
}

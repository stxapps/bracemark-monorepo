'use client';

// The desktop rail's dock state — whether it is collapsed, and how wide it has
// been dragged — read by the two components that must agree on it: the rail
// (sidebar.tsx), which renders nothing while collapsed, and the topbar, whose
// "Show sidebar" control and title-as-drawer-door appear in its place. The state
// itself is web-react's sidebar-view-store (device-local, wiped on sign-out);
// this is the React edge of it plus the rail's measure.
//
// `useSyncExternalStore`, not a `useState` loaded in an effect (the collapsed-ids
// hook's shape), because the effect version paints the rail at its default
// first: a user who collapsed it would watch it appear and vanish on every visit
// to /links, and one who narrowed it would watch the link list jump sideways.
// The store's own snapshot is read on a client mount, so the rail's first paint
// is the stored one. The server snapshot is the default and is only ever used on
// a hydration pass, which this frame never has — the (app) tree renders nothing
// until auth resolves on the client (auth-guard.tsx) — but it is what keeps the
// hook honest if that ever changes: hydrate at the default, then correct.

import { useSyncExternalStore } from 'react';

import {
  DEFAULT_SIDEBAR_RAIL,
  getSidebarRail,
  subscribeSidebarRail,
  writeSidebarRail,
} from '@stxapps/web-react';
import { MD_QUERY } from '@stxapps/web-ui/hooks/use-media-query';

// The rail's measure, in px. `default` is the 15rem it was fixed at before it
// could move. `min` keeps a two-level row's label readable (60px of chevron,
// icon and indent before the text, plus 16px per level); `max` is where a wider
// rail stops buying label and starts costing the link list its date column.
// The rail also caps itself at 40vw in CSS, so a width dragged on a wide window
// can't eat a narrow one's pane.
export const RAIL_WIDTH = { min: 192, default: 240, max: 400 } as const;

// Dragging the edge this far in — past the rail's minimum — collapses it on
// release, the way an editor's side bar folds when you drag it shut. Half the
// minimum, so it takes a deliberate drag rather than an overshoot of `min`.
export const RAIL_COLLAPSE_BELOW = RAIL_WIDTH.min / 2;

// The rail's one fraction of the window. Mirrored by `max-w-[40vw]` on the rail;
// JS applies it while dragging so the stored width is the one on screen (a
// width the CSS then capped would leave the handle behind the pointer and the
// separator announcing a number the rail isn't).
const RAIL_MAX_VIEWPORT_FRACTION = 0.4;

export function clampRailWidth(width: number): number {
  const viewportMax =
    typeof window === 'undefined'
      ? RAIL_WIDTH.max
      : Math.floor(window.innerWidth * RAIL_MAX_VIEWPORT_FRACTION);
  const max = Math.max(RAIL_WIDTH.min, Math.min(RAIL_WIDTH.max, viewportMax));
  return Math.round(Math.min(max, Math.max(RAIL_WIDTH.min, width)));
}

export function useSidebarRail(): { collapsed: boolean; width: number } {
  const rail = useSyncExternalStore(
    subscribeSidebarRail,
    getSidebarRail,
    () => DEFAULT_SIDEBAR_RAIL,
  );
  // Clamped on READ against the constant bounds only (not the viewport — that
  // cap is the CSS's job once the width is stored), so a width stored before a
  // bound moved, or written by hand, can't size the rail outside them.
  const width = Math.round(
    Math.min(RAIL_WIDTH.max, Math.max(RAIL_WIDTH.min, rail.width ?? RAIL_WIDTH.default)),
  );
  return { collapsed: rail.collapsed, width };
}

// FOCUS HANDOFF. Both toggles unmount the control that was pressed — Hide lives
// in the rail it hides, Show in the topbar slot that only exists while the rail
// is gone — so a keyboard user who presses either would otherwise land on
// `body`, at the top of the tab order. The toggle notes which control should
// catch focus, and that control takes it on mount (`useRailFocusTarget`). Only
// when focus is ACTUALLY inside what is going away: collapsing with the shortcut
// while typing in the search box must not yank focus out of it.
let pendingFocus: 'show' | 'hide' | null = null;

export const RAIL_ATTR = 'data-links-rail';
export const SHOW_RAIL_ATTR = 'data-show-links-rail';

export function setRailCollapsed(collapsed: boolean): void {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  if (collapsed && active?.closest(`[${RAIL_ATTR}]`)) pendingFocus = 'show';
  else if (!collapsed && active?.closest(`[${SHOW_RAIL_ATTR}]`)) pendingFocus = 'hide';
  else pendingFocus = null;
  writeSidebarRail({ collapsed });
}

export function toggleRailCollapsed(): void {
  setRailCollapsed(!getSidebarRail().collapsed);
}

export function setRailWidth(width: number | null): void {
  writeSidebarRail({ width: width === null ? null : clampRailWidth(width) });
}

// Whether the control named `target` should take focus as it mounts. Consumes
// the handoff, so StrictMode's second mount (and any later remount) leaves
// focus where the first put it.
export function takeRailFocus(target: 'show' | 'hide'): boolean {
  if (pendingFocus !== target) return false;
  pendingFocus = null;
  return true;
}

// ⌘\ / Ctrl+\ toggles the rail — Notion's binding for the same act. Not ⌘B,
// the more common one: in Firefox that opens the BROWSER's bookmarks sidebar,
// which in a bookmark manager is the one collision that would actually confuse.
// Spelled once here for the handler, the buttons' `aria-keyshortcuts`, and
// their tooltip.
export const RAIL_SHORTCUT_ARIA = 'Meta+\\ Control+\\';

export function railShortcutHint(): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return mac ? '⌘\\' : 'Ctrl+\\';
}

export function isRailShortcut(e: KeyboardEvent): boolean {
  return e.key === '\\' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

// Only where there IS a rail. Below `md` the rail is a drawer the title opens,
// so the shortcut would flip a hidden flag the user would only meet later, on a
// wider window, as a rail that inexplicably isn't there. The same query string
// the CSS matched, read at the moment of the keystroke (docs/safe-area.md).
export function railShortcutApplies(): boolean {
  return window.matchMedia(MD_QUERY).matches;
}

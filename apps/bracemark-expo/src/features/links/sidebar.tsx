// The links drawer's content — the expo port of bracemark-web's
// `(app)/links/_panes/sidebar.tsx` (canonical doc: the brand mark, the
// count-gated filter box, the two collapsible sections — Lists as the system
// three + the user's own, Tags — as selectable filters; parent rows carry a
// separate chevron hit target; hidden-list pruning and the own-lock badge; a
// final utility band with the Show All reset and the Manage lists/tags links
// out to settings). On a phone-width window the rail is a Drawer
// ((app)/links/_layout.tsx), so selecting an entry also closes it; on a wide one
// the same component is docked beside the list (features/links/sidebar-rail.tsx), where
// that close is a no-op.
//
// Collapse state persists device-locally (the `sidebar_view` table via
// sidebar-view-store — expo's home for what web keeps in localStorage), the
// same as web: loaded once after mount, written on every toggle, never synced.
// The one intentional divergence left is native affordances (no hover, so the
// "Lock now" action is always shown; the row press also closes the drawer).

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDrawerStatus } from '@react-navigation/drawer';
import { useRouter } from 'expo-router';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Folder,
  Hash,
  Inbox,
  Layers,
  ListFilter,
  Lock,
  LockOpen,
  type LucideIcon,
  Settings2,
  Trash2,
} from 'lucide-react-native';
import { withUniwind } from 'uniwind';

import {
  readSidebarCollapsedIds,
  useLists,
  useLocks,
  useTags,
  writeSidebarCollapsedIds,
} from '@stxapps/expo-react';
import {
  ALL_LABEL,
  ancestorIds,
  ARCHIVE_ID,
  flattenToRows,
  flattenTree,
  MY_LIST_ID,
  TRASH_ID,
  TREE_INDENT_MAX_LEVELS_NARROW,
  TREE_INDENT_WIDTH,
  type TreeItem,
  type TreeNode,
  withoutSubtrees,
} from '@stxapps/shared';

import { BrandLockup } from '../../components/brand-lockup';
import { TreeLevelMarker } from '../../components/links/tree-level';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { type Selection, useLinksPage } from './page-provider';

const StyledSafeAreaView = withUniwind(SafeAreaView);

// The filter box only earns its keep past a handful of entries — below this
// combined count (lists + tags) the trees fit at a glance and a box would read
// as noise (web sidebar's FILTER_MIN_ITEMS, verbatim).
const FILTER_MIN_ITEMS = 12;

// Reserved collapse ids for the two section headers — prefixed so they can't
// collide with a real list/tag id in the shared collapsed set.
const SECTION_LISTS = 'section:lists';
const SECTION_TAGS = 'section:tags';

// The device-local collapsed set — persisted to the `sidebar_view` table
// (sidebar-view-store), the expo home of what web keeps in localStorage. Starts
// empty (everything expanded) and loads the stored set AFTER mount, exactly like
// web: the ids aren't needed for first paint, so starting expanded and applying
// the stored set is fine (and keeps the sqlite open/read off the render path).
// Writes are the whole set each toggle — best-effort in the store, so a storage
// hiccup just means this session stays in memory.
function useCollapsedIds() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const ids = readSidebarCollapsedIds();
    if (ids.length > 0) setCollapsed(new Set(ids));
  }, []);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeSidebarCollapsedIds([...next]);
      return next;
    });
  }, []);

  // Un-collapse a set of ids (a selected row's ancestors) so the active row is
  // never hidden under a collapsed parent. Returns the same set unchanged when
  // none were collapsed, so the selection effect below doesn't re-render (and
  // doesn't write) for a no-op — the common case, most selections are visible.
  const expand = useCallback((ids: readonly string[]) => {
    setCollapsed((prev) => {
      if (!ids.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      writeSidebarCollapsedIds([...next]);
      return next;
    });
  }, []);

  return { collapsed, toggle, expand };
}

// The icon for a list row: the system three keep their familiar marks, every
// user list is a folder.
function listIcon(id: string): LucideIcon {
  if (id === MY_LIST_ID) return Inbox;
  if (id === ARCHIVE_ID) return Archive;
  if (id === TRASH_ID) return Trash2;
  return Folder;
}

// The row's stable handle for the mobile flows (docs/e2e.md, _the testID
// contract_), derived from the SELECTION rather than the label because the label
// is user data: the system three are renameable (settings/lists-section.tsx) and
// every other row is a list or tag the user named. Only the system list ids are
// strings a flow can hardcode (`my-list`, `archive`, `trash`); a user row's is a
// uuid, but the shape is uniform, so a `maestro hierarchy` dump names what it
// found. It is an id and not the label for the sharper reason too — with the
// drawer OPEN the links topbar is still in Android's hierarchy behind it, and its
// title is this same list's name, so `tapOn: 'My List'` is ambiguous there and
// resolves to the occluded one (docs/app-drivers.md, _a text match can resolve to
// a node under the drawer_).
function navTestID(selection: Selection): string {
  if (selection.kind === 'list') return `links-nav-list-${selection.id}`;
  if (selection.kind === 'tag') return `links-nav-tag-${selection.id}`;
  return `links-nav-${selection.kind}`;
}

function isActive(current: Selection, candidate: Selection): boolean {
  if (current.kind !== candidate.kind) return false;
  if (current.kind === 'list' || current.kind === 'tag') {
    return current.id === (candidate as { id: string }).id;
  }
  return true;
}

function NavItem({
  icon,
  label,
  selection,
  onSelected,
  depth = 0,
  expanded,
  onToggle,
  showSlot = false,
  badge,
  action,
}: {
  icon: LucideIcon;
  label: string;
  selection: Selection;
  // Fired after the row commits its selection — the drawer closes on it.
  onSelected: () => void;
  // Tree nesting level — indents the row TREE_INDENT_WIDTH per level, up to
  // TREE_INDENT_MAX_LEVELS_NARROW (@stxapps/shared sync/tree.ts), and numbers it past
  // that. Applied to the whole row so the chevron indents with the label.
  depth?: number;
  // Present only on rows with children: whether the subtree is shown, and the
  // chevron's toggle — a SEPARATE sibling Pressable on the LEFT (row press =
  // select filter, chevron = toggle), like web.
  expanded?: boolean;
  onToggle?: () => void;
  // In a tree, childless rows still reserve the chevron's width so their icons
  // line up under the parents' labels; standalone rows (Show All) pass false.
  showSlot?: boolean;
  // Trailing marker INSIDE the row press target (the own-lock badge), after the
  // label — non-interactive.
  badge?: ReactNode;
  // Trailing INTERACTIVE control on the RIGHT, a SEPARATE sibling Pressable
  // after the row (row press = select filter, action = its own onPress), like
  // the left chevron. The list rows' "Lock now". No hover on native, so it's
  // always shown when present.
  action?: ReactNode;
}) {
  const { selection: current, setSimpleQuery } = useLinksPage();
  const active = isActive(current, selection);

  // No `gap` on the row: the 4px that used to sit BETWEEN the chevron slot and
  // the row is an `ml-1` BEFORE the slot instead (web twin, same move). The icon
  // and label stay put; only the chevron moves, 4px right — closer to the icon
  // it belongs to (16px to the glyph, was 20) and indented under the section
  // header's chevron (centre 20 vs the header's 15) rather than stacking on it.
  // The trailing action takes its own `ml-1` for the same 4px the gap gave it.
  return (
    <View
      className="w-full flex-row items-center"
      // Capped at TREE_INDENT_MAX_LEVELS_NARROW (@stxapps/shared sync/tree.ts): past it
      // a deep chain's labels had no width left, so the row numbers its level.
      style={
        depth > 0
          ? { paddingLeft: Math.min(depth, TREE_INDENT_MAX_LEVELS_NARROW) * TREE_INDENT_WIDTH }
          : undefined
      }
    >
      <TreeLevelMarker depth={depth} maxLevels={TREE_INDENT_MAX_LEVELS_NARROW} />
      {onToggle ? (
        <Button
          variant="ghost"
          size="icon-sm"
          onPress={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          // 32, not the size's own 36: this is a row affordance in a dense tree
          // and its web twin pins the same box for the same reason.
          className="ml-1 size-8 shrink-0"
        >
          {/* The open state SWAPS THE GLYPH; it does NOT rotate one, which is
              what the web twin does (`rotate-90` on a ChevronRight). Uniwind
              can't carry that class: tailwind v4 compiles `rotate-90` to the
              standalone `rotate: 90deg` property, which uniwind maps to the
              nested style `{ rotate: { rotateZ: '90deg' } }` and its runtime
              then hands to RN as `transform: [{ rotate: { rotateZ: ... } }]` —
              a transform entry whose value is an object, which RN drops. No
              lint error, no type error, just a chevron that never turns
              (docs/theme.md, _extending_). lucide's ChevronDown IS
              ChevronRight at 90°, so the result is identical, and settings'
              lists-section.tsx already collapses its list tree this way. */}
          <Icon
            as={expanded ? ChevronDown : ChevronRight}
            className="size-4 text-muted-foreground"
          />
        </Button>
      ) : showSlot ? (
        <View className="ml-1 size-8 shrink-0" />
      ) : null}
      <Pressable
        role="button"
        testID={navTestID(selection)}
        onPress={() => {
          setSimpleQuery(selection);
          onSelected();
        }}
        // `accessibilityState`, not the web twin's `aria-current` — RN doesn't
        // declare that prop, so it announced nothing. See the twin comment in
        // features/settings/sidebar.tsx.
        accessibilityState={{ selected: active }}
        className={cn(
          'min-w-0 flex-1 flex-row items-center gap-2 rounded-md px-2 py-2',
          active && 'bg-muted',
        )}
      >
        <Icon
          as={icon}
          className={cn('size-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground')}
        />
        <Text
          numberOfLines={1}
          className={cn(
            'min-w-0 flex-1 text-sm',
            active ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          {label}
        </Text>
        {badge && <View className="shrink-0 text-muted-foreground">{badge}</View>}
      </Pressable>
      {action}
    </View>
  );
}

// One forest → rows, parents before their children, each indented by its
// depth; collapsed parents keep their subtree unrendered. Generic over lists
// and tags — the two differ only in icon and selection kind.
//
// Rendered FLAT, from `flattenToRows`, not by a component that renders itself
// for each node's children (web's sidebar, verbatim): a row is indented by
// padding and never nested in its parent's view, so the output is the same, but
// a self-rendering component makes the React tree as deep as the list tree —
// which is as deep as a `parentId` chain a restored backup or another device
// decides (@stxapps/shared sync/tree.ts) — and React's commit walks its tree
// with a call frame per level.
function NavTree<T extends TreeItem & { name: string }>({
  nodes,
  iconFor,
  selectionFor,
  onSelected,
  collapsed,
  onToggle,
  badgeFor,
  actionFor,
}: {
  nodes: TreeNode<T>[];
  iconFor: (id: string) => LucideIcon;
  selectionFor: (id: string) => Selection;
  onSelected: () => void;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  badgeFor?: (id: string) => ReactNode;
  actionFor?: (id: string) => ReactNode;
}) {
  return (
    <>
      {flattenToRows(nodes, collapsed).map(({ item, depth, hasChildren, parentId }) => (
        <NavItem
          // Scoped to the sibling group, as a key was when each level was its own
          // list: a row that changes parent remounts, and a store holding one id
          // twice under different parents does not hand React two equal keys.
          key={`${parentId ?? ''}/${item.id}`}
          icon={iconFor(item.id)}
          label={item.name}
          selection={selectionFor(item.id)}
          onSelected={onSelected}
          depth={depth}
          expanded={hasChildren ? !collapsed.has(item.id) : undefined}
          onToggle={hasChildren ? () => onToggle(item.id) : undefined}
          showSlot
          badge={badgeFor?.(item.id)}
          action={actionFor?.(item.id)}
        />
      ))}
    </>
  );
}

// A collapsible section: a disclosure-button header (chevron + uppercase
// label) over its rows. `forceOpen` overrides the stored collapse — used while
// filtering so matches are never hidden behind a collapsed header (web parity).
function Section({
  id,
  label,
  collapsed,
  onToggle,
  forceOpen = false,
  children,
}: {
  id: string;
  label: string;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const isCollapsed = !forceOpen && collapsed.has(id);
  return (
    <View className="flex-col gap-0.5">
      <Pressable
        role="button"
        onPress={() => onToggle(id)}
        aria-expanded={!isCollapsed}
        // `pt-4 pb-1` — asymmetric on purpose, and NOT the split the web twin
        // takes. There the section's top space had to move out onto the wrapper,
        // because the button's box is what the focus ring outlines and the label
        // sat jammed against the bottom of it. Nothing outlines this box: no
        // focus ring, and this Pressable paints no pressed state. What the
        // padding buys here instead is the TARGET — 16 + a 16px line + 4 = the
        // 36px rung expo's pointer targets sit on (docs/accessibility.md). Move
        // the 16 onto the wrapper for web parity and the row becomes 24px tall,
        // thumb-sized for nothing.
        className="w-full flex-row items-center gap-1 rounded-md px-2 pt-4 pb-1"
      >
        {/* Glyph swap, not a rotation — see the NavItem chevron above for why a
            `rotate-90` class is silently inert here. */}
        <Icon
          as={isCollapsed ? ChevronRight : ChevronDown}
          className="size-3.5 text-muted-foreground"
        />
        <Text className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </Text>
      </Pressable>
      {!isCollapsed && children}
    </View>
  );
}

// A footer navigation row (Manage lists / tags). Not a filter selection — a
// plain route push out to the settings section, closing the drawer with it.
function FooterLink({
  icon,
  label,
  href,
  onSelected,
}: {
  icon: LucideIcon;
  label: string;
  href: string;
  onSelected: () => void;
}) {
  const router = useRouter();
  return (
    <Pressable
      role="button"
      onPress={() => {
        router.push(href);
        onSelected();
      }}
      className="w-full flex-row items-center gap-2 rounded-md px-2 py-2"
    >
      <Icon as={icon} className="size-4 shrink-0 text-muted-foreground" />
      <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-muted-foreground">
        {label}
      </Text>
    </Pressable>
  );
}

export function Sidebar({
  closeDrawer,
  headerAction,
}: {
  closeDrawer: () => void;
  // The brand row's trailing control — the docked rail's Hide (sidebar-rail.tsx), and
  // nothing in the overlay drawer, which is dismissed the usual three ways.
  headerAction?: ReactNode;
}) {
  const lists = useLists();
  const tags = useTags();
  const { selection } = useLinksPage();
  const { hiddenListIds, listLocks, lockList } = useLocks();
  const { collapsed, toggle, expand } = useCollapsedIds();
  const [filter, setFilter] = useState('');

  // What the Lists section actually renders: the tree minus the hidden lists
  // (locked + hideList — lock-provider's closure set, so a hidden parent takes
  // its subtree with it structurally too). Their LINKS are excluded separately
  // at the query layer (use-links); this is the navigation half of hiding. The
  // lists stay reachable in Settings → Lists, which is the reveal path.
  const visibleLists = useMemo(() => withoutSubtrees(lists, hiddenListIds), [lists, hiddenListIds]);

  // Flattened once for the count gate and the filter matches (web parity). When
  // filtering we show a FLAT list of matches — hierarchy and collapse ignored,
  // the usual find-in-list behavior.
  const listRows = useMemo(() => flattenTree(visibleLists), [visibleLists]);
  const tagRows = useMemo(() => flattenTree(tags), [tags]);
  const showFilter = listRows.length + tagRows.length >= FILTER_MIN_ITEMS;

  const q = filter.trim().toLowerCase();
  // Only actually filter while the box is shown: if the account shrinks below
  // the gate with stale text in state, the (now hidden) box mustn't keep the
  // trees filtered.
  const filtering = showFilter && q !== '';
  const listMatches = filtering
    ? listRows.filter((n) => n.item.name.toLowerCase().includes(q))
    : [];
  const tagMatches = filtering ? tagRows.filter((n) => n.item.name.toLowerCase().includes(q)) : [];

  // Keep the active row reachable: expand its collapsed ancestors whenever the
  // selection (or the trees it lives in) changes — a selection can arrive from
  // outside the visible tree (the default landing, a deep link), so its parents
  // may be collapsed. Section collapse is left alone (web sidebar parity).
  useEffect(() => {
    if (selection.kind === 'list') expand(ancestorIds(lists, selection.id));
    else if (selection.kind === 'tag') expand(ancestorIds(tags, selection.id));
  }, [selection, lists, tags, expand]);

  // Put away a keyboard left over across a drawer transition — in the CONTAINER,
  // once, not in each row's press: ui/dialog.tsx and ui/alert-dialog.tsx make the
  // same move on `open` for the same reason (docs/soft-keyboard.md, _dismissal_).
  // Both directions strand one, and nothing else drops it:
  //  - CLOSING. The filter box sits outside the scroller below, whose
  //    `keyboardShouldPersistTaps="handled"` deliberately DELIVERS the row tap
  //    rather than spending it on the keyboard (that is what fixes this rail's
  //    double-tap). So the row selects and the drawer slides away, while the
  //    keyboard stays up over the links list — fed by a field now off-screen.
  //  - OPENING. The links search box keeps its focus through the menu press
  //    (`autoFocus`, search-bar.tsx), so its keyboard covers the foot of the rail
  //    that press just opened.
  // A SWIPE close is the one path already handled: react-native-drawer-layout's
  // own `keyboardDismissMode` defaults to `'on-drag'` and dismisses at gesture
  // start. It only sees the gesture though — a row press, a footer link and the
  // backdrop tap all close the drawer programmatically, straight past it.
  // The first run is skipped on purpose: this content mounts with the screen (a
  // Drawer never renders it lazily) at status `'closed'`, and SearchBar can mount
  // autofocused in that same commit when a `?text=` query arrives with the screen
  // — dismissing there would race that focus. Comparing against the previous
  // status, rather than a "have I mounted" flag, also survives an effect that is
  // mounted twice (StrictMode): an unchanged status is a no-op.
  const drawerStatus = useDrawerStatus();
  const prevDrawerStatus = useRef(drawerStatus);
  useEffect(() => {
    if (drawerStatus === prevDrawerStatus.current) return;
    prevDrawerStatus.current = drawerStatus;
    if (Platform.OS !== 'web') Keyboard.dismiss();
  }, [drawerStatus]);

  // A lock marker on rows that carry their OWN engaged lock (children a lock
  // merely covers stay unmarked — the locked ancestor is the visual cue).
  const listBadge = (id: string) =>
    listLocks.get(id)?.locked ? (
      <Icon as={Lock} className="size-3.5 text-muted-foreground" accessibilityLabel="Locked" />
    ) : undefined;

  // A one-tap "Lock now" for a row's OWN lock while it's currently UNLOCKED —
  // re-engages it in-memory (no password; relocking is free). Only these rows
  // get it: a locked row already shows the static badge above and its press-
  // through is the unlock pane (Main), and a row with no lock has nothing to
  // re-lock. A separate Pressable from the row, so tapping it re-locks without
  // selecting the list or closing the drawer. When the row IS the list being
  // shown (or covers it), Main swaps to the lock pane underneath this open rail —
  // and that pane goes up WITHOUT asking for the unlock: no autofocus, so no
  // keyboard over the drawer, and no biometric prompt (main.tsx; docs/locks.md,
  // _a hand relock does not ask to be undone_). Re-locking a `hideList` list also
  // re-prunes it from this rail on the next coverage recompute, so it simply
  // disappears. Web parity: sidebar.tsx's hover-revealed button (native has no
  // hover, so it's always shown).
  const listAction = (id: string) => {
    const info = listLocks.get(id);
    if (!info || info.locked) return undefined;
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Lock list"
        onPress={() => lockList(id)}
        className="ml-1 size-8 shrink-0"
      >
        <Icon as={LockOpen} className="size-3.5 text-muted-foreground" />
      </Button>
    );
  };

  return (
    // `bg-popover` and a `border-r`, not the page's `bg-background` it used to
    // wear with no edge at all — and in dark those two are the whole of what
    // separates this drawer from the screen it slides over (docs/theme.md,
    // _elevation_). The navigator's scrim cannot: black at 50% takes a white
    // page to mid-grey, but has nothing to subtract from a 0.145 one, which
    // left the panel at APCA Lc 0.7 against its own backdrop (75 in light). And
    // there was no edge to fall back on, which is where this differed from the
    // web twin: web's left sheet draws `border-r` itself (web-ui `sheet.tsx`),
    // while react-navigation only borders a `permanent` drawer — a `front` one
    // gets a corner radius, and this square view paints over that. So the edge
    // is drawn HERE, in the token rather than the navigator's own
    // `colors.border`: that theme is the stock light one with `background`
    // alone replaced (src/app/_layout.tsx), so its border is a fixed light grey
    // in both modes. The edge is the lever (Lc 13.0); the fill is what makes it
    // a region rather than a line. Light is untouched by the fill: the two
    // tokens are the same white there.
    <StyledSafeAreaView className="flex-1 border-r border-border bg-popover">
      {/* The brand lockup, pinned above the scrolling trees at the topbar's own
          `h-14` with the same hairline under it, so the drawer's header and the
          bar it covers meet across the frame. It was a bare mark with no
          wordmark and no rule — which made this the one surface in the app that
          showed the icon WITHOUT the name, the exact inverse of what a drawer is
          for. Both rails now open on the identical lockup (components/
          brand-lockup.tsx), as do bracemark-web's two rails, its auth card and
          the browser extension's popup header. */}
      <View className="h-14 justify-center border-b border-border px-4">
        <BrandLockup action={headerAction} />
      </View>

      {/* Count-gated find-in-nav over both trees (funnel icon, not a magnifier):
          it filters which list/tag ROWS show, distinct from the topbar's Search
          over saved LINK content. Pinned above the trees; the funnel icon is an
          absolute overlay the input's left padding clears (web parity).

          `pt-2` clears the header's hairline; the icon's absolute `top` is the
          input's own vertical centre measured from this wrapper's edge, so it
          moves with that padding. */}
      {showFilter && (
        <View className="relative px-3 pt-2 pb-1">
          <View className="absolute left-5 z-10" style={{ top: 21, pointerEvents: 'none' }}>
            <Icon as={ListFilter} className="size-3.5 text-muted-foreground" />
          </View>
          <Input
            value={filter}
            onChangeText={setFilter}
            placeholder="Filter lists & tags"
            aria-label="Filter lists and tags"
            className="pl-9"
          />
        </View>
      )}

      {/* `keyboardShouldPersistTaps="handled"` because the filter box above
          sits OUTSIDE this scroller: with the default `"never"`, a tap made
          while the keyboard is up dismisses it AND is withheld from the row —
          so filtering to a list and tapping it did nothing the first time, and
          navigated only on a second press. That is this rail's primary flow.
          It is also why the drawer-status effect above exists: a tap that
          reaches the row is a tap the keyboard doesn't get, so closing the
          drawer has to put it away itself.
          `on-drag` covers the other half: the tree is what you scroll to read
          past the keyboard. */}
      <ScrollView
        className="flex-1 px-2 pb-4"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {/* Lists: the system three (My List / Archive / Trash) plus the user's
            own, merged in the read layer, ordered by `rank`, nested by
            `parentId` (see use-lists). My List is the default landing
            selection (page-provider). */}
        <Section
          id={SECTION_LISTS}
          label="Lists"
          collapsed={collapsed}
          onToggle={toggle}
          forceOpen={filtering}
        >
          {filtering ? (
            listMatches.length > 0 ? (
              listMatches.map((node) => (
                <NavItem
                  key={node.item.id}
                  icon={listIcon(node.item.id)}
                  label={node.item.name}
                  selection={{ kind: 'list', id: node.item.id }}
                  onSelected={closeDrawer}
                  badge={listBadge(node.item.id)}
                  action={listAction(node.item.id)}
                />
              ))
            ) : (
              // `pl-6` parks the text under the section header's LABEL rather
              // than under the rows it stands in for — an empty section has no
              // row to align to, and a row's own text sits at 36px (matches) or
              // 72px (tree rows, past the chevron slot), both of which read as
              // indented for a one-line placeholder. This header's label starts
              // at 26px (`px-2` + `size-3.5` chevron + `gap-1`), so 24px is the
              // near miss we accept. Web makes the same CHOICE against its own
              // header but lands on a different NUMBER (`pl-5.5`, 22px) — this
              // side's chrome is a size up throughout, so the two files agree on
              // the rule, not on the value. Don't sync them by hand.
              <Text className="py-1 pr-2 pl-6 text-xs text-muted-foreground">
                No matching lists
              </Text>
            )
          ) : (
            <NavTree
              nodes={visibleLists}
              iconFor={listIcon}
              selectionFor={(id) => ({ kind: 'list', id })}
              onSelected={closeDrawer}
              collapsed={collapsed}
              onToggle={toggle}
              badgeFor={listBadge}
              actionFor={listAction}
            />
          )}
        </Section>

        {/* Tags are all user-created — no system tag — so this section is
            empty until the user makes one. */}
        <Section
          id={SECTION_TAGS}
          label="Tags"
          collapsed={collapsed}
          onToggle={toggle}
          forceOpen={filtering}
        >
          {filtering ? (
            tagMatches.length > 0 ? (
              tagMatches.map((node) => (
                <NavItem
                  key={node.item.id}
                  icon={Hash}
                  label={node.item.name}
                  selection={{ kind: 'tag', id: node.item.id }}
                  onSelected={closeDrawer}
                />
              ))
            ) : (
              <Text className="py-1 pr-2 pl-6 text-xs text-muted-foreground">No matching tags</Text>
            )
          ) : tags.length === 0 ? (
            <Text className="py-1 pr-2 pl-6 text-xs text-muted-foreground">No tags yet</Text>
          ) : (
            <NavTree
              nodes={tags}
              iconFor={() => Hash}
              selectionFor={(id) => ({ kind: 'tag', id })}
              onSelected={closeDrawer}
              collapsed={collapsed}
              onToggle={toggle}
            />
          )}
        </Section>

        {/* Utility band: the Show All reset, a separator, then the Manage
            links out to settings (web's footer band). Hidden while filtering —
            none of these are list/tag entities, so a find-in-nav query never
            matches them; clearing the box brings the band back. */}
        {!filtering && (
          <View className="mt-3 flex-col gap-0.5 border-t border-border pt-2">
            <NavItem
              icon={Layers}
              label={ALL_LABEL}
              selection={{ kind: 'all' }}
              onSelected={closeDrawer}
            />
            <View className="my-1 border-t border-border" />
            <FooterLink
              icon={Settings2}
              label="Manage lists"
              href="/settings/lists"
              onSelected={closeDrawer}
            />
            <FooterLink
              icon={Settings2}
              label="Manage tags"
              href="/settings/tags"
              onSelected={closeDrawer}
            />
          </View>
        )}
      </ScrollView>
    </StyledSafeAreaView>
  );
}

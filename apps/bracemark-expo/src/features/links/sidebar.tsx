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
// "Lock now" action is always shown; the row press also closes the drawer; and
// no `title` tooltip to read a truncated name by, so a long-press shows it —
// `Peek`, below).

import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Keyboard, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDrawerStatus } from '@react-navigation/drawer';
import { FlashList } from '@shopify/flash-list';
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
  useTagsOrUndefined,
  writeSidebarCollapsedIds,
} from '@stxapps/expo-react';
import {
  ALL_LABEL,
  ancestorIds,
  ARCHIVE_ID,
  flattenToRows,
  flattenTree,
  MY_LIST_ID,
  type TagItem,
  TRASH_ID,
  TREE_INDENT_MAX_LEVELS_NARROW,
  TREE_INDENT_WIDTH,
  type TreeItem,
  type TreeNode,
  withoutSubtrees,
} from '@stxapps/shared';

import { BrandLockup } from '../../components/brand-lockup';
import { TreeLevelMarker } from '../../components/links/tree-level-marker';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Peek, type PeekAnchor } from '../../components/ui/peek';
import { Text } from '../../components/ui/text';
import { useProgressiveCount } from '../../lib/use-progressive-count';
import { cn } from '../../lib/utils';
import { type Selection, useLinksPage } from './page-provider';

const StyledSafeAreaView = withUniwind(SafeAreaView);

// The filter box only earns its keep past a handful of entries — below this
// combined count (lists + tags) the trees fit at a glance and a box would read
// as noise (web sidebar's FILTER_MIN_ITEMS, verbatim).
const FILTER_MIN_ITEMS = 12;

// The filter's no-match result, stable so the entries' memo holds unfiltered.
const NO_MATCHES: { item: TreeItem & { name: string } }[] = [];

// From how many rows (lists + tags, the whole library) the rail is a FlashList
// rather than a ScrollView filled a slice a frame (lib/use-progressive-count.ts).
// MEASURED, both ways, by the render leg's sidebar window (docs/e2e.md, _the
// render leg_; docs/client-queries.md, _the tree surfaces mount every row_),
// 2026-11-16, iPhone 17 Pro simulator and Pixel 8 emulator — five
// collapse/expand pairs of both sections, total blocking (median of three):
//
//                         ScrollView, sliced      FlashList
//   plus-full    (~64)    iOS 53     Android 168   iOS 387   Android 715
//   plus-worst  (~212)    iOS 213    Android 792   iOS 500   Android 968
//   plus-large  (~600)    iOS 977    Android 3,581 iOS 454   Android 879   (ms)
//
// A ScrollView pays per row; FlashList pays a near-constant price for its own
// measuring and recycling, which a small library never earns back. The lines
// cross at ~240 rows on the emulator and ~350 on the simulator; 300 sits between.
// (FlashList drops fewer frames at every size — the sliced fill is many short
// frames — but the stall a person feels is the blocking.)
const VIRTUALIZE_MIN_ROWS = 300;

// The rail's content inset — `px-2 pb-4`, as the ScrollView it replaced carried.
const NAV_CONTENT_PADDING = { paddingHorizontal: 8, paddingBottom: 16 };

// useTags' own empty default, stable so the trees' memos hold while pending.
const NO_TAGS: TreeNode<TagItem>[] = [];

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

// The row's selection, built from what it is rather than handed in as an
// object — a fresh `{ kind, id }` every parent render would defeat NavItem's
// memo below.
type NavKind = 'list' | 'tag' | 'all';

// A row's long-press: what it is, its full label, and its view to measure.
type PeekHandler = (kind: NavKind, id: string | undefined, label: string, row: View | null) => void;

// How many ancestors a peek names before it elides the rest — a chain can run as
// deep as a restored backup made it (@stxapps/shared sync/tree.ts), and the
// nearest few are the ones that place a row.
const PEEK_PATH_LEVELS = 3;

// A nested row's place in its tree, for the peek's second line: its ancestors'
// names, root first, the far end elided past PEEK_PATH_LEVELS. Undefined for a
// top-level row. Past TREE_INDENT_MAX_LEVELS_NARROW the indent stops saying
// where a row sits, and a filter match is shown flat, so this is often the only
// place the rail says it.
function peekPath<T extends TreeItem & { name: string }>(
  nodes: TreeNode<T>[],
  id: string,
): string | undefined {
  const ids = ancestorIds(nodes, id);
  if (ids.length === 0) return undefined;
  const names = new Map(flattenTree(nodes).map((n) => [n.item.id, n.item.name]));
  const shown = ids.slice(-PEEK_PATH_LEVELS).map((a) => names.get(a) ?? '');
  return [...(ids.length > PEEK_PATH_LEVELS ? ['…'] : []), ...shown].join(' › ');
}

function selectionOf(kind: NavKind, id: string | undefined): Selection {
  return kind === 'all' ? { kind } : { kind, id: id ?? '' };
}

// The id of the list or tag the page shows, or null for anything else — what a
// row compares itself against to know it's the active one.
function activeIdFor(selection: Selection, kind: 'list' | 'tag'): string | null {
  return selection.kind === kind ? selection.id : null;
}

// MEMOIZED, and every prop is either a primitive or stable across the
// sidebar's renders — which is why it takes `active` and `onSelect` rather than
// reading the page context itself. A row that read the context re-rendered on
// every selection, every rail toggle and, on a phone, every drawer open and
// close (`useDrawerStatus` re-renders the sidebar): all 209 of `plus-worst`'s
// rows for a change that moves one highlight. Now a render re-renders the rows
// whose props moved — the old active row, the new one, a toggled parent.
const NavItem = memo(function NavItem({
  icon,
  label,
  kind,
  id,
  active,
  onSelect,
  depth = 0,
  expanded,
  onToggle,
  showSlot = false,
  badge,
  action,
  onPeek,
  onPeekEnd,
  spaced = false,
}: {
  icon: LucideIcon;
  label: string;
  // What the row selects: a list or tag by id, or Show All.
  kind: NavKind;
  id?: string;
  active: boolean;
  // Commits the row's selection and closes the drawer. Stable — see above.
  onSelect: (selection: Selection) => void;
  // Tree nesting level — indents the row TREE_INDENT_WIDTH per level, up to
  // TREE_INDENT_MAX_LEVELS_NARROW (@stxapps/shared sync/tree.ts), and numbers it past
  // that. Applied to the whole row so the chevron indents with the label.
  depth?: number;
  // Present only on rows with children: whether the subtree is shown, and the
  // chevron's toggle — a SEPARATE sibling Pressable on the LEFT (row press =
  // select filter, chevron = toggle), like web. The toggle takes the row's id
  // so one stable function serves every row.
  expanded?: boolean;
  onToggle?: (id: string) => void;
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
  // Hold-to-read the whole label (components/ui/peek.tsx): a long-press hands the
  // row's own view up to be measured, the press-out ends it. Both stable — see
  // the memo note above. Absent on Show All, whose label never truncates.
  // Setting `onLongPress` is also what keeps a hold from SELECTING: RN skips
  // `onPress` on the release of a press its long-press fired on.
  onPeek?: PeekHandler;
  onPeekEnd?: () => void;
  // The 2px above a section's row — what the section's `gap-0.5` gave it when
  // the rows were children of a section view. A margin on the row's own view, not
  // a wrapper: a View per row is cost on the path that mounts every row.
  spaced?: boolean;
}) {
  const selection = selectionOf(kind, id);
  const rowRef = useRef<View>(null);

  // No `gap` on the row: the 4px that used to sit BETWEEN the chevron slot and
  // the row is an `ml-1` BEFORE the slot instead (web twin, same move). The icon
  // and label stay put; only the chevron moves, 4px right — closer to the icon
  // it belongs to (16px to the glyph, was 20) and indented under the section
  // header's chevron (centre 20 vs the header's 15) rather than stacking on it.
  // The trailing action takes its own `ml-1` for the same 4px the gap gave it.
  return (
    <View
      className={cn('w-full flex-row items-center', spaced && 'mt-0.5')}
      // Capped at TREE_INDENT_MAX_LEVELS_NARROW (@stxapps/shared sync/tree.ts): past it
      // a deep chain's labels had no width left, so the row numbers its level.
      style={
        depth > 0
          ? { paddingLeft: Math.min(depth, TREE_INDENT_MAX_LEVELS_NARROW) * TREE_INDENT_WIDTH }
          : undefined
      }
    >
      <TreeLevelMarker depth={depth} maxLevels={TREE_INDENT_MAX_LEVELS_NARROW} />
      {onToggle && expanded !== undefined ? (
        <Button
          variant="ghost"
          size="icon-sm"
          onPress={() => onToggle(id ?? '')}
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
        ref={rowRef}
        role="button"
        testID={navTestID(selection)}
        onPress={() => onSelect(selection)}
        onLongPress={onPeek ? () => onPeek(kind, id, label, rowRef.current) : undefined}
        onPressOut={onPeekEnd}
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
});

// What the rail scrolls: ONE flat array — each section's header, its rows (or
// the line that stands in for them), and the utility band — handed to a single
// FlashList, so only the entries on screen are mounted, once the library is big
// enough for that to pay (VIRTUALIZE_MIN_ROWS); below it, the same entries in a
// ScrollView, a slice a frame.
//
// ⚠ VIRTUALIZED, because nothing bounds how many lists or tags a library holds
// (docs/data-limits.md, _counts: none per kind_). The rail mounts with the links
// screen, and it used to mount every row: in the links screen's first commits,
// again each time a section opened, and (on a phone) under the drawer's slide —
// a screenful a frame (lib/use-progressive-count.ts) at best, the whole tree's
// native mounting at worst (docs/client-queries.md, _the tree surfaces mount
// every row_). A section is no longer a view wrapping its rows: its header is an
// entry like they are, and a collapsed one simply contributes no rows.
//
// Rows stay FLAT, from `flattenToRows`, as they were before the list existed: a
// row is indented by padding and never nested in its parent's view, so the
// React tree stays shallow however deep a `parentId` chain a restored backup or
// another device decides (@stxapps/shared sync/tree.ts).
type NavEntry =
  | {
      type: 'header';
      key: string;
      id: string;
      label: string;
      // The header's handle for the mobile flows (docs/e2e.md, _the testID
      // contract_) — the label is ambiguous with "Manage lists" and with a list
      // the user named "Lists".
      testID: string;
      collapsed: boolean;
    }
  | {
      type: 'list' | 'tag';
      key: string;
      id: string;
      name: string;
      depth: number;
      // Present only on a tree row with children: whether its subtree shows.
      expanded?: boolean;
      // A tree row reserves the chevron's slot and indents; a filter match is
      // flat, like the find-in-list it is.
      tree: boolean;
      active: boolean;
    }
  | { type: 'note'; key: string; text: string }
  | { type: 'band'; key: string; active: boolean };

function navEntries({
  lists,
  tags,
  tagsLoaded,
  collapsed,
  filtering,
  listMatches,
  tagMatches,
  activeListId,
  activeTagId,
  allActive,
}: {
  lists: TreeNode<TreeItem & { name: string }>[];
  tags: TreeNode<TreeItem & { name: string }>[];
  tagsLoaded: boolean;
  collapsed: ReadonlySet<string>;
  filtering: boolean;
  listMatches: { item: TreeItem & { name: string } }[];
  tagMatches: { item: TreeItem & { name: string } }[];
  activeListId: string | null;
  activeTagId: string | null;
  allActive: boolean;
}): NavEntry[] {
  const out: NavEntry[] = [];
  const section = (
    kind: 'list' | 'tag',
    id: string,
    label: string,
    testID: string,
    nodes: TreeNode<TreeItem & { name: string }>[],
    matches: { item: TreeItem & { name: string } }[],
    activeId: string | null,
    empty: string | null,
  ) => {
    // `filtering` overrides a stored collapse, so matches are never hidden
    // behind a collapsed header (web parity).
    const isCollapsed = !filtering && collapsed.has(id);
    out.push({ type: 'header', key: `header:${kind}`, id, label, testID, collapsed: isCollapsed });
    if (isCollapsed) return;
    if (filtering) {
      if (matches.length === 0) {
        out.push({
          type: 'note',
          key: `note:${kind}`,
          text: kind === 'list' ? 'No matching lists' : 'No matching tags',
        });
      }
      for (const { item } of matches) {
        out.push({
          type: kind,
          key: `${kind}-match:${item.id}`,
          id: item.id,
          name: item.name,
          depth: 0,
          tree: false,
          active: item.id === activeId,
        });
      }
      return;
    }
    if (empty !== null) {
      out.push({ type: 'note', key: `note:${kind}`, text: empty });
      return;
    }
    for (const { item, depth, hasChildren, parentId } of flattenToRows(nodes, collapsed)) {
      out.push({
        type: kind,
        // Scoped to the sibling group, as a key was when each level was its own
        // list: a row that changes parent remounts, and a store holding one id
        // twice under different parents does not hand the list two equal keys.
        key: `${kind}:${parentId ?? ''}/${item.id}`,
        id: item.id,
        name: item.name,
        depth,
        expanded: hasChildren ? !collapsed.has(item.id) : undefined,
        tree: true,
        active: item.id === activeId,
      });
    }
  };

  section(
    'list',
    SECTION_LISTS,
    'Lists',
    'links-nav-section-lists',
    lists,
    listMatches,
    activeListId,
    null,
  );
  // Tags are all user-created — no system tag — so this section is empty until
  // the user makes one; and says nothing until the read has landed.
  if (!tagsLoaded && !filtering) {
    out.push({
      type: 'header',
      key: 'header:tag',
      id: SECTION_TAGS,
      label: 'Tags',
      testID: 'links-nav-section-tags',
      collapsed: collapsed.has(SECTION_TAGS),
    });
  } else {
    section(
      'tag',
      SECTION_TAGS,
      'Tags',
      'links-nav-section-tags',
      tags,
      tagMatches,
      activeTagId,
      tags.length === 0 ? 'No tags yet' : null,
    );
  }
  // The utility band — hidden while filtering: none of it is a list or tag, so a
  // find-in-nav query never matches it; clearing the box brings it back.
  if (!filtering) out.push({ type: 'band', key: 'band', active: allActive });
  return out;
}

// Below VIRTUALIZE_MIN_ROWS the entries go into a ScrollView, each section's rows
// a screenful in the commit that mounts them and the rest a slice a frame
// (lib/use-progressive-count.ts) — what the rail did before the FlashList, and
// still the cheaper path at this size. Per SECTION, as it was: a collapsed
// section renders no group, so opening it again fills from the first slice
// rather than committing every row it holds at once.
type Segment =
  { key: string; entry: NavEntry; rows?: undefined } | { key: string; rows: NavEntry[] };

function slicedSegments(entries: readonly NavEntry[]): Segment[] {
  const out: Segment[] = [];
  let rows: NavEntry[] | null = null;
  for (const entry of entries) {
    if (entry.type === 'list' || entry.type === 'tag') {
      if (!rows) {
        rows = [];
        out.push({ key: `rows:${entry.type}`, rows });
      }
      rows.push(entry);
    } else {
      rows = null;
      out.push({ key: entry.key, entry });
    }
  }
  return out;
}

function SlicedEntries({
  entries,
  render,
}: {
  entries: NavEntry[];
  render: (info: { item: NavEntry }) => ReactNode;
}) {
  const shown = useProgressiveCount(entries.length);
  return entries
    .slice(0, shown)
    .map((entry) => <Fragment key={entry.key}>{render({ item: entry })}</Fragment>);
}

// A section's header: a disclosure button (chevron + uppercase label) that
// collapses and expands the section's rows.
function SectionHeader({
  id,
  label,
  testID,
  collapsed,
  onToggle,
}: {
  id: string;
  label: string;
  testID: string;
  collapsed: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <Pressable
      role="button"
      testID={testID}
      onPress={() => onToggle(id)}
      aria-expanded={!collapsed}
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
        as={collapsed ? ChevronRight : ChevronDown}
        className="size-3.5 text-muted-foreground"
      />
      <Text className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </Text>
    </Pressable>
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
  // Pending kept apart from empty for the "No tags yet" line below: lists need
  // no such care, as the system three make a loaded tree never empty.
  const loadedTags = useTagsOrUndefined();
  const tags = loadedTags ?? NO_TAGS;
  const { selection, setSimpleQuery } = useLinksPage();
  // One select for every row, stable across renders so NavItem's memo holds:
  // the drawer's `closeDrawer` is a new closure each time the navigator renders
  // this, so it is read through a ref at press time rather than closed over.
  const closeDrawerRef = useRef(closeDrawer);
  closeDrawerRef.current = closeDrawer;
  const select = useCallback(
    (next: Selection) => {
      setSimpleQuery(next);
      closeDrawerRef.current();
    },
    [setSimpleQuery],
  );
  // The footer links' close, stable for the same reason.
  const closeDrawerNow = useCallback(() => closeDrawerRef.current(), []);
  const activeListId = activeIdFor(selection, 'list');
  const activeTagId = activeIdFor(selection, 'tag');
  const { hiddenListIds, listLocks, lockList } = useLocks();
  const { collapsed, toggle, expand } = useCollapsedIds();
  const [filter, setFilter] = useState('');

  // The held row's peek (components/ui/peek.tsx). The row's box comes back from
  // `measure` asynchronously, and a finger can lift before it does — so
  // each hold takes a token, the press-out spends it, and a measurement that
  // arrives for a spent token is dropped rather than opening a bubble nothing
  // will close. The trees are read through refs so both handlers stay stable
  // for NavItem's memo.
  const [peek, setPeek] = useState<{
    anchor: PeekAnchor;
    title: string;
    detail?: string;
  } | null>(null);
  const peekToken = useRef(0);
  const trees = useRef({ lists, tags });
  trees.current = { lists, tags };
  const showPeek = useCallback<PeekHandler>((kind, id, label, row) => {
    const token = ++peekToken.current;
    const detail =
      id === undefined || kind === 'all'
        ? undefined
        : peekPath<TreeItem & { name: string }>(
            kind === 'list' ? trees.current.lists : trees.current.tags,
            id,
          );
    // Page offsets, not `measureInWindow` — see components/ui/peek.tsx.
    row?.measure((_x, _y, width, height, pageX, pageY) => {
      if (token === peekToken.current)
        setPeek({ anchor: { x: pageX, y: pageY, width, height }, title: label, detail });
    });
  }, []);
  const endPeek = useCallback(() => {
    peekToken.current++;
    setPeek(null);
  }, []);

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
  // Which scroller (VIRTUALIZE_MIN_ROWS, above): counted over the whole library,
  // not the rows a collapse or a filter leaves showing, so folding a section never
  // swaps one list for the other under the finger.
  const virtualize = listRows.length + tagRows.length >= VIRTUALIZE_MIN_ROWS;

  const q = filter.trim().toLowerCase();
  // Only actually filter while the box is shown: if the account shrinks below
  // the gate with stale text in state, the (now hidden) box mustn't keep the
  // trees filtered.
  const filtering = showFilter && q !== '';
  const listMatches = useMemo(
    () => (filtering ? listRows.filter((n) => n.item.name.toLowerCase().includes(q)) : NO_MATCHES),
    [filtering, listRows, q],
  );
  const tagMatches = useMemo(
    () => (filtering ? tagRows.filter((n) => n.item.name.toLowerCase().includes(q)) : NO_MATCHES),
    [filtering, tagRows, q],
  );

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
  const listBadge = useCallback(
    (id: string) =>
      listLocks.get(id)?.locked ? (
        <Icon as={Lock} className="size-3.5 text-muted-foreground" accessibilityLabel="Locked" />
      ) : undefined,
    [listLocks],
  );

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
  const listAction = useCallback(
    (id: string) => {
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
    },
    [listLocks, lockList],
  );

  // Everything the rail scrolls, as one flat array (navEntries, above).
  const allActive = selection.kind === 'all';
  const entries = useMemo(
    () =>
      navEntries({
        lists: visibleLists,
        tags,
        tagsLoaded: loadedTags !== undefined,
        collapsed,
        filtering,
        listMatches,
        tagMatches,
        activeListId,
        activeTagId,
        allActive,
      }),
    [
      visibleLists,
      tags,
      loadedTags,
      collapsed,
      filtering,
      listMatches,
      tagMatches,
      activeListId,
      activeTagId,
      allActive,
    ],
  );

  // One entry. Everything it reads besides the entry is in the dependencies, so
  // it doubles as the list's `extraData`: a lock engaged or released re-renders
  // the rows on screen. A row's `spaced` and a note's `mt-0.5` are the 2px a
  // section's `gap-0.5` used to put between its header and each of its rows.
  const renderEntry = useCallback(
    ({ item: entry }: { item: NavEntry }) => {
      switch (entry.type) {
        case 'header':
          return (
            <SectionHeader
              id={entry.id}
              label={entry.label}
              testID={entry.testID}
              collapsed={entry.collapsed}
              onToggle={toggle}
            />
          );
        case 'note':
          return (
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
            <Text className="mt-0.5 py-1 pr-2 pl-6 text-xs text-muted-foreground">
              {entry.text}
            </Text>
          );
        case 'band':
          return (
            // Utility band: the Show All reset, a separator, then the Manage
            // links out to settings (web's footer band).
            <View className="mt-3 flex-col gap-0.5 border-t border-border pt-2">
              <NavItem
                icon={Layers}
                label={ALL_LABEL}
                kind="all"
                active={entry.active}
                onSelect={select}
              />
              <View className="my-1 border-t border-border" />
              <FooterLink
                icon={Settings2}
                label="Manage lists"
                href="/settings/lists"
                onSelected={closeDrawerNow}
              />
              <FooterLink
                icon={Settings2}
                label="Manage tags"
                href="/settings/tags"
                onSelected={closeDrawerNow}
              />
            </View>
          );
        default: {
          const isList = entry.type === 'list';
          return (
            <NavItem
              spaced
              icon={isList ? listIcon(entry.id) : Hash}
              label={entry.name}
              kind={entry.type}
              id={entry.id}
              active={entry.active}
              onSelect={select}
              depth={entry.depth}
              expanded={entry.expanded}
              onToggle={entry.expanded !== undefined ? toggle : undefined}
              showSlot={entry.tree}
              badge={isList ? listBadge(entry.id) : undefined}
              action={isList ? listAction(entry.id) : undefined}
              onPeek={showPeek}
              onPeekEnd={endPeek}
            />
          );
        }
      }
    },
    [toggle, select, closeDrawerNow, listBadge, listAction, showPeek, endPeek],
  );

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
          drawer has to put it away itself. FlashList forwards both to its
          ScrollView.
          `on-drag` covers the other half: the tree is what you scroll to read
          past the keyboard.
          Lists first: the system three (My List / Archive / Trash) plus the
          user's own, merged in the read layer, ordered by `rank`, nested by
          `parentId` (see use-lists). My List is the default landing selection
          (page-provider). */}
      {virtualize ? (
        <View className="flex-1">
          <FlashList
            testID="links-nav"
            data={entries}
            renderItem={renderEntry}
            extraData={renderEntry}
            keyExtractor={(entry) => entry.key}
            getItemType={(entry) => entry.type}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={NAV_CONTENT_PADDING}
          />
        </View>
      ) : (
        <ScrollView
          testID="links-nav"
          className="flex-1 px-2 pb-4"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {slicedSegments(entries).map((segment) =>
            segment.rows ? (
              <SlicedEntries key={segment.key} entries={segment.rows} render={renderEntry} />
            ) : (
              <Fragment key={segment.key}>{renderEntry({ item: segment.entry })}</Fragment>
            ),
          )}
        </ScrollView>
      )}
      <Peek anchor={peek?.anchor ?? null} title={peek?.title ?? ''} detail={peek?.detail} />
    </StyledSafeAreaView>
  );
}

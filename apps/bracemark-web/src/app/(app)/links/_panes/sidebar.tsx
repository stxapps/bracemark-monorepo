'use client';

// Full-height left rail: the brand lockup at the top, an optional filter box
// (shown only once there are enough lists/tags to be worth scanning), then two
// collapsible sections — Lists (the My List / Archive / Trash system lists plus
// the user's own) and Tags — as selectable filters. Only the brand and the
// (count-gated) filter box are pinned; a final utility band — Show All (the
// unfiltered "view everything" reset) and the Manage lists / Manage tags links —
// scrolls with the trees rather than pinning, since those are low-frequency and
// pinning them was squeezing the tree's scroll room. Clicking an entry sets the
// shared selection (see page-provider); the main pane reacts.
//
// HIDDEN BELOW `md`, where it becomes a drawer summoned from the topbar's title
// (sidebar-drawer.tsx) — the same trade the settings rail makes at the same
// breakpoint, for the same reason: 15rem of rail on a 390px screen left ~150px
// for the links themselves. What differs is the SHAPE it takes, because the
// content differs. Settings' rail is six flat destinations, so it folds into a
// dropdown; this one is two collapsible trees plus a filter box and per-row lock
// controls, which no menu can hold — so it keeps its full body and slides in
// over the pane instead. `SidebarBody` is that body, rendered by both hosts, so
// there is one nav in one file and the drawer can't drift from the rail.
//
// The two hosts are chosen by CSS (`hidden md:flex` here, `md:hidden` on the
// drawer's trigger), never by a measured width, so nothing can disagree with the
// breakpoint the stylesheet matched (docs/safe-area.md, _the core problem_).
//
// Tree rows collapse: a parent row carries a chevron on the LEFT as a SEPARATE
// hit target (row click = select filter, chevron = toggle), matching the Lists
// settings section; childless rows get a same-width spacer so their icons stay
// aligned. Section headers collapse the whole group the same way. All collapse
// state — tree ids and the two reserved section ids — is device-local view
// state, persisted through web-react's sidebar-view-store (localStorage; see
// there for why not the synced settings and not the Dexie local-settings row).
// The store owns the key and the read-write so this stays shape-only, and so the
// sign-out teardown (clear-data.ts) can wipe it — the ids are this account's.
// Selecting a list/tag from elsewhere (the editors' ListSelect, a link)
// auto-expands its ancestors so the active row is never hidden under a collapsed
// parent.
//
// The filter box is a plain find-in-nav over both trees (funnel icon, not a
// magnifier): it filters which list/tag ROWS show, distinct from the topbar's
// Search, which searches saved LINK content. It's count-gated so small accounts
// never see a box that could be mistaken for link search.

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Archive,
  ChevronRight,
  Folder,
  Hash,
  Inbox,
  Layers,
  ListFilter,
  Lock,
  LockOpen,
  Settings2,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';

import {
  ALL_LABEL,
  ancestorIds,
  ARCHIVE_ID,
  flattenTree,
  MY_LIST_ID,
  TRASH_ID,
  type TreeItem,
  type TreeNode,
} from '@stxapps/shared';
import {
  readSidebarCollapsedIds,
  useLists,
  useLocks,
  useTags,
  writeSidebarCollapsedIds,
} from '@stxapps/web-react';
import { BracemarkIcon } from '@stxapps/web-ui/components/icons/bracemark-icon';
import { Input } from '@stxapps/web-ui/components/ui/input';
import { cn } from '@stxapps/web-ui/lib/utils';

import { type Selection, useLinksPage } from '../_contexts/page-provider';

// Reserved collapse ids for the two section headers. Prefixed so they can't
// collide with a real list/tag id in the shared collapsed set.
const SECTION_LISTS = 'section:lists';
const SECTION_TAGS = 'section:tags';

// Fired by any row that COMMITS A NAVIGATION — a filter selection or a Manage
// link — never by a chevron, which only reveals more of this nav. The rail
// leaves it undefined (there is nothing to dismiss); the drawer passes its close
// so picking a list gets you to the links instead of leaving you looking at the
// panel you picked it from. A context rather than a prop because the rows sit
// three components deep (Section → NavTree → NavItem) and none of the layers
// between them has any other use for it.
const NavigateContext = createContext<(() => void) | undefined>(undefined);

// The shared focus ring for this nav's hand-rolled controls (rows, chevrons,
// section headers, footer links) — the same one the settings rail uses, so a
// keyboard walks the two surfaces through identical highlights.
const FOCUS_RING = 'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none';

// The filter box is chrome that only earns its keep past a handful of entries.
// Below this combined count (lists + tags) the whole tree fits at a glance, so
// we hide the box entirely — it reads as noise (or worse, as link search) when
// there's nothing to filter.
const FILTER_MIN_ITEMS = 12;

// The device-local collapsed set (sidebar-view-store). Starts empty (everything
// expanded) and loads the stored set AFTER mount — reading storage during render
// would make the hydration pass disagree with the server HTML. Writes are the
// whole set each toggle, best-effort in the store, so a storage hiccup just
// means this session stays in memory (and a bad read starts expanded).
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

// Drop the currently-hidden lists (a locked lock with hideList — lock-provider's
// closure set, so a hidden parent takes its subtree with it structurally too).
// The lists stay reachable in Settings → Lists, which is the reveal path.
function pruneHidden<T extends TreeItem>(
  nodes: TreeNode<T>[],
  hiddenIds: ReadonlySet<string>,
): TreeNode<T>[] {
  if (hiddenIds.size === 0) return nodes;
  return nodes
    .filter((node) => !hiddenIds.has(node.item.id))
    .map((node) =>
      node.children.length > 0
        ? { ...node, children: pruneHidden(node.children, hiddenIds) }
        : node,
    );
}

// The icon for a list row: the system three keep their familiar marks, every
// user list is a folder.
function listIcon(id: string): React.ReactNode {
  if (id === MY_LIST_ID) return <Inbox className="size-4" />;
  if (id === ARCHIVE_ID) return <Archive className="size-4" />;
  if (id === TRASH_ID) return <Trash2 className="size-4" />;
  return <Folder className="size-4" />;
}

function isActive(current: Selection, candidate: Selection): boolean {
  if (current.kind !== candidate.kind) return false;
  // Entity axes match by id; `all`/`none` carry none, so a kind match is enough
  // (candidate rows are only ever list/tag/all — `none` never highlights a row).
  if (current.kind === 'list' || current.kind === 'tag') {
    return current.id === (candidate as { id: string }).id;
  }
  return true;
}

function NavItem({
  icon,
  label,
  selection,
  badge,
  action,
  depth = 0,
  expanded,
  onToggle,
  showSlot = false,
}: {
  icon: React.ReactNode;
  label: string;
  selection: Selection;
  // Trailing chrome INSIDE the row button (non-interactive) — the list rows'
  // lock marker.
  badge?: React.ReactNode;
  // Trailing INTERACTIVE control, rendered as a SIBLING after the row button
  // (never nested inside it — a button in a button is invalid and would fire the
  // selection). The list rows' hover-revealed "Lock now".
  action?: React.ReactNode;
  // Tree nesting level — indents the row one step per level (16px, matching
  // the list pickers' indent). Applied to the whole row so the chevron indents
  // with the label.
  depth?: number;
  // Present only on rows with children: whether the subtree is shown, and the
  // chevron's toggle. The chevron is a sibling button on the LEFT, never nested
  // in the row button (a button inside a button is invalid and would fire the
  // selection).
  expanded?: boolean;
  onToggle?: () => void;
  // In a tree, childless rows still reserve the chevron's width so their icons
  // line up under the parents' labels. Standalone rows (e.g. Show All) pass
  // false so they don't carry a phantom indent.
  showSlot?: boolean;
}) {
  const { selection: current, setSimpleQuery } = useLinksPage();
  const onNavigate = useContext(NavigateContext);
  const active = isActive(current, selection);

  return (
    <div
      className="group/navitem flex w-full items-center gap-1"
      style={depth > 0 ? { paddingLeft: `${depth * 16}px` } : undefined}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            FOCUS_RING,
          )}
        >
          <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
        </button>
      ) : showSlot ? (
        <span className="size-6 shrink-0" />
      ) : null}
      <button
        type="button"
        // Selecting is a navigation, so it dismisses the drawer when there is
        // one — the chevron above deliberately does not, since expanding a
        // subtree is how you find the row you actually want.
        onClick={() => {
          setSimpleQuery(selection);
          onNavigate?.();
        }}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
          'hover:bg-muted',
          FOCUS_RING,
          active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
        <span className="truncate">{label}</span>
        {badge && (
          <span className="ml-auto flex shrink-0 items-center text-muted-foreground/70">
            {badge}
          </span>
        )}
      </button>
      {action}
    </div>
  );
}

// One subtree → rows, parents before their children, each indented by its
// depth; collapsed parents keep their subtree unrendered. Selection is by the
// entity's own id. Generic over lists and tags — the two differ only in icon
// and selection kind.
function NavTree<T extends TreeItem & { name: string }>({
  nodes,
  iconFor,
  selectionFor,
  badgeFor,
  actionFor,
  collapsed,
  onToggle,
}: {
  nodes: TreeNode<T>[];
  iconFor: (id: string) => React.ReactNode;
  selectionFor: (id: string) => Selection;
  badgeFor?: (id: string) => React.ReactNode;
  actionFor?: (id: string) => React.ReactNode;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isCollapsed = collapsed.has(node.item.id);
        return (
          <Fragment key={node.item.id}>
            <NavItem
              icon={iconFor(node.item.id)}
              label={node.item.name}
              selection={selectionFor(node.item.id)}
              badge={badgeFor?.(node.item.id)}
              action={actionFor?.(node.item.id)}
              depth={node.depth}
              expanded={hasChildren ? !isCollapsed : undefined}
              onToggle={hasChildren ? () => onToggle(node.item.id) : undefined}
              showSlot
            />
            {hasChildren && !isCollapsed && (
              <NavTree
                nodes={node.children}
                iconFor={iconFor}
                selectionFor={selectionFor}
                badgeFor={badgeFor}
                actionFor={actionFor}
                collapsed={collapsed}
                onToggle={onToggle}
              />
            )}
          </Fragment>
        );
      })}
    </>
  );
}

// A collapsible section: a disclosure-button header (chevron + uppercase label)
// over its rows. `forceOpen` overrides the stored collapse — used while
// filtering so matches are never hidden behind a collapsed header.
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
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={!isCollapsed}
        className={cn(
          'flex w-full items-center gap-1 rounded-md px-2 pt-3 pb-1 text-muted-foreground/70 transition-colors hover:text-foreground',
          FOCUS_RING,
        )}
      >
        <ChevronRight className={cn('size-3 transition-transform', !isCollapsed && 'rotate-90')} />
        <span className="text-xs font-semibold tracking-wide uppercase">{label}</span>
      </button>
      {!isCollapsed && children}
    </div>
  );
}

// A footer navigation link (Manage lists / tags). Not a filter selection — a
// link out to the settings section that creates/renames/deletes. Styled like
// the nav items above but it's an <a>, so it navigates (and Back returns here to
// keep organizing) rather than calling setSimpleQuery.
function FooterLink({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  const onNavigate = useContext(NavigateContext);

  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        'text-muted-foreground hover:bg-muted',
        FOCUS_RING,
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="truncate">{label}</span>
    </Link>
  );
}

// The rail's whole body — brand, filter box, trees, utility band — rendered by
// the rail below and by the drawer (sidebar-drawer.tsx) at the same time it is
// hidden. Both hosts supply their own outer box (a bordered `aside`, a sheet
// panel); everything inside the box is here.
export function SidebarBody({
  onNavigate,
  action,
}: {
  onNavigate?: () => void;
  // Trailing control for the brand row. The rail has nothing to put there; the
  // drawer puts its dismiss there, so the panel closes from the same row it
  // announces itself in rather than from a button floating over the trees.
  action?: React.ReactNode;
}) {
  const lists = useLists();
  const tags = useTags();
  const { selection } = useLinksPage();
  const { hiddenListIds, listLocks, lockList } = useLocks();
  const { collapsed, toggle, expand } = useCollapsedIds();
  const [filter, setFilter] = useState('');

  // What the Lists section actually renders: the tree minus the hidden lists
  // (locked + hideList). Their LINKS are excluded separately at the query layer
  // (use-links); this is the navigation half of hiding.
  const visibleLists = useMemo(() => pruneHidden(lists, hiddenListIds), [lists, hiddenListIds]);

  // A lock marker on rows that carry their OWN engaged lock (children a lock
  // merely covers stay unmarked — the locked ancestor is the visual cue).
  const listBadge = (id: string) =>
    listLocks.get(id)?.locked ? <Lock className="size-3.5" aria-label="Locked" /> : undefined;

  // A one-click "Lock now" for a row's OWN lock while it's currently UNLOCKED —
  // re-engages it in-memory (no password; relocking is free). Only these rows get
  // it: a locked row already shows the static badge above and its click-through
  // is the unlock pane, and a row with no lock has nothing to re-lock. Rendered
  // as a sibling of the row button (NavItem's `action`) and hover/focus-revealed
  // so it stays out of the way until wanted — but always in the tab order for
  // keyboards. Re-locking a `hideList` list also re-prunes it from this rail on
  // the next coverage recompute, so it simply disappears.
  const listAction = (id: string) => {
    const info = listLocks.get(id);
    if (!info || info.locked) return undefined;
    return (
      <button
        type="button"
        aria-label="Lock list"
        title="Lock list"
        onClick={() => lockList(id)}
        // Revealed by hover, by focus — and unconditionally on a COARSE
        // POINTER, which has no hover to reveal it with. That mattered less
        // when this rail was desktop-only; now the drawer puts the same rows on
        // a phone, where an `opacity-0` button is invisible but still tappable,
        // which is worse than absent. Same "always shown, no hover" resolution
        // bracemark-expo reached for its drawer (docs/locks.md).
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition',
          'opacity-0 group-hover/navitem:opacity-100 hover:bg-muted hover:text-foreground',
          'focus-visible:opacity-100 pointer-coarse:opacity-100',
          FOCUS_RING,
        )}
      >
        <LockOpen className="size-3.5" />
      </button>
    );
  };

  // Flattened once for the count gate and the filter matches. When filtering we
  // show a flat list of matches (hierarchy and collapse ignored) — the usual
  // find-in-list behavior.
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
  // selection (or the trees it lives in) changes. Section collapse is left
  // alone — hiding a whole group is a deliberate choice we respect.
  useEffect(() => {
    if (selection.kind === 'list') expand(ancestorIds(lists, selection.id));
    else if (selection.kind === 'tag') expand(ancestorIds(tags, selection.id));
  }, [selection, lists, tags, expand]);

  return (
    <NavigateContext.Provider value={onNavigate}>
      {/* The lockup, at the same `h-14` as the topbar so the two hairlines meet
          across the frame — and identical to the settings rail's and the browser
          extension's options page (mark `h-5`, wordmark `text-[0.9375rem]
          font-semibold tracking-tight`, `gap-2.5`). Three surfaces, one lockup:
          it should be the same product wherever you entered it. */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <BracemarkIcon className="h-5 w-auto shrink-0" aria-hidden="true" />
        <span className="text-[0.9375rem] leading-none font-semibold tracking-tight">
          Bracemark
        </span>
        {action ? <span className="ml-auto flex items-center">{action}</span> : null}
      </div>

      {showFilter && (
        <div className="shrink-0 px-2 pt-2">
          {/* Inset to the ROWS, not to the rail: the box's left edge lines up
              with the rows' hover background and its text with their labels
              (`pl-8` = the icon slot + `gap-2`), so the filter reads as the head
              of the list it filters rather than as a floating field. */}
          <div className="relative">
            <ListFilter className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter lists & tags"
              aria-label="Filter lists and tags"
              className="h-8 pl-8 text-sm"
            />
          </div>
        </div>
      )}

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {/* Lists: one ordered tree of the system three (My List / Archive /
            Trash) and the user's own lists, merged in the read layer and ordered
            by `rank`, nested by `parentId` (see use-lists). The system lists are
            code defaults, so they're always present; My List is the default
            landing selection (see page-provider). */}
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
                  badge={listBadge(node.item.id)}
                  action={listAction(node.item.id)}
                />
              ))
            ) : (
              <p className="px-2 py-1 text-xs text-muted-foreground/60">No matching lists</p>
            )
          ) : (
            <NavTree
              nodes={visibleLists}
              iconFor={listIcon}
              selectionFor={(id) => ({ kind: 'list', id })}
              badgeFor={listBadge}
              actionFor={listAction}
              collapsed={collapsed}
              onToggle={toggle}
            />
          )}
        </Section>

        {/* Tags are all user-created — no system tag — so this section is empty
            until the user makes one. */}
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
                  icon={<Hash className="size-4" />}
                  label={node.item.name}
                  selection={{ kind: 'tag', id: node.item.id }}
                />
              ))
            ) : (
              <p className="px-2 py-1 text-xs text-muted-foreground/60">No matching tags</p>
            )
          ) : tags.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground/60">No tags yet</p>
          ) : (
            <NavTree
              nodes={tags}
              iconFor={() => <Hash className="size-4" />}
              selectionFor={(id) => ({ kind: 'tag', id })}
              collapsed={collapsed}
              onToggle={toggle}
            />
          )}
        </Section>

        {/* Low-frequency utility band, scrolling with the trees rather than
            pinned (pinning it starved the tree's scroll room): the Show All
            reset, a separator, then the Manage links out to settings. The
            border-t sets it off from the Tags section above. Hidden while
            filtering — none of these are list/tag entities, so a find-in-nav
            query never matches them, and leaving them under the results reads
            as noise. Clearing the box brings the band back. */}
        {!filtering && (
          <div className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2">
            <NavItem
              icon={<Layers className="size-4" />}
              label={ALL_LABEL}
              selection={{ kind: 'all' }}
            />
            <div className="my-1 border-t border-border" />
            <FooterLink
              href="/settings/lists"
              icon={<Settings2 className="size-4" />}
              label="Manage lists"
            />
            <FooterLink
              href="/settings/tags"
              icon={<Settings2 className="size-4" />}
              label="Manage tags"
            />
          </div>
        )}
      </nav>
    </NavigateContext.Provider>
  );
}

// The rail itself: the body in a fixed 15rem column, from `md` up. Below that it
// is not rendered at all (`hidden` — display:none, so its rows leave the tab
// order and the a11y tree too) and the drawer carries the same body instead.
export function Sidebar() {
  return (
    <aside className="hidden h-full w-60 shrink-0 flex-col border-r border-border bg-background md:flex">
      <SidebarBody />
    </aside>
  );
}

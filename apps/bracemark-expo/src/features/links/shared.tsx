// Pieces shared by the two link-item renderers (link-row, link-card) and the
// main pane — the expo port of bracemark-web's `_layouts/shared/` grab-bag
// (layout-chrome, hooks, types, the badges; the tag chips, the row menu, and
// the preview-image chain have their own files on both platforms —
// link-tag-chips.tsx, link-row-menu.tsx, link-media.tsx).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  Archive,
  Folder,
  Hash,
  Inbox,
  Layers,
  type LucideIcon,
  Pin,
  RefreshCw,
  SearchX,
  StickyNote,
  Trash2,
} from 'lucide-react-native';

import { type LinkView, useTags } from '@stxapps/expo-react';
import {
  ARCHIVE_ID,
  DEFAULT_LIST_ID,
  type LinkSortOn,
  TRASH_ID,
  treeNameMap,
} from '@stxapps/shared';

import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { type Selection, useLinksPage } from './page-provider';
import { useLinksViewState } from './view-state-provider';

// The uniform contract between the main pane's FlashList and whichever item
// renderer the `linksLayout` setting picks — web's LinkLayoutProps one level
// down: there the layout owns the virtualizer so the shared surface is the
// LAYOUT; here the layout is FlashList config (main.tsx) so the shared surface
// is the ITEM. `sortOn` feeds the row's date column only — the card shows no
// date (web parity) — but stays in the contract so the renderItem call site is
// uniform across layouts.
export type LinkItemProps = {
  link: LinkView;
  pinned: boolean;
  // At the pinned section's ends — the row menu disables the Move up/down that
  // would fall off them (web's LinkRowMenu props). Meaningful only when
  // `pinned`; false otherwise.
  isFirst: boolean;
  isLast: boolean;
  sortOn: LinkSortOn;
  tagsById: Map<string, string>;
  // Bulk-edit mode: a checkbox appears and a press toggles selection instead of
  // opening the URL (web's selectable rows/cards).
  selectMode: boolean;
  selected: boolean;
  onToggle: () => void;
};

export function PinnedBadge() {
  return <Icon as={Pin} className="size-3.5 shrink-0 text-muted-foreground" aria-label="Pinned" />;
}

// Badge only — the note text stays behind the (future) edit dialog (web's "View
// note" menu item, which needs it), web's rationale: an inline note would cost
// its line on every item, and most links have none.
export function NoteBadge() {
  return (
    <Icon
      as={StickyNote}
      className="size-3.5 shrink-0 text-muted-foreground"
      aria-label="Has note"
    />
  );
}

// An empty pane is not one state, it's seven, and they want different words —
// bracemark-web's `_layouts/shared/layout-chrome.tsx` makes the argument and this
// is its port. "No links here yet." was true in all seven and useful in none: in
// Trash it reads as a fault, in a tag view it doesn't say how a link gets
// tagged, and on a fresh account — the one place this screen is guaranteed to be
// seen — it answers a question nobody asked instead of offering the one action
// available.
//
// So the copy is keyed off the same `selection` the topbar titles the view with,
// and only the views where adding a link actually lands HERE offer the add
// control (`cta`): a tag can't be assigned at creation from that button, and
// nothing is "added" to Trash or Archive, so those three explain the mechanism
// in a sentence instead of offering an action that wouldn't do what it says.
//
// The one divergence from web's copy is where a link comes FROM. Web's default
// list names "the browser extension and the mobile app" as the other ways in;
// on the phone the other way in is the SHARE SHEET, which is the single most
// useful thing a new user of this app can be told and is invisible until
// somebody says it (docs/share-sheet.md).
function emptyCopy(selection: Selection): {
  icon: LucideIcon;
  title: string;
  body: string;
  cta?: boolean;
} {
  if (selection.kind === 'none') {
    return {
      icon: SearchX,
      title: 'No links match',
      body: 'Try fewer or different words, or clear the search to see everything again.',
    };
  }
  if (selection.kind === 'tag') {
    return {
      icon: Hash,
      title: 'Nothing tagged yet',
      body: 'Links get this tag from their ⋯ menu, from the editor, or from bulk edit.',
    };
  }
  if (selection.kind === 'all') {
    return {
      icon: Layers,
      title: 'No links saved yet',
      body: 'Every link you save shows up here, whichever list it lives in.',
      cta: true,
    };
  }
  if (selection.id === TRASH_ID) {
    return {
      icon: Trash2,
      title: 'Trash is empty',
      body: 'Links you remove land here and stay until you delete them permanently.',
    };
  }
  if (selection.id === ARCHIVE_ID) {
    return {
      icon: Archive,
      title: 'Nothing archived',
      body: 'Archive a link when you are done with it — it leaves My List but stays saved.',
    };
  }
  if (selection.id === DEFAULT_LIST_ID) {
    return {
      icon: Inbox,
      title: 'No links yet',
      body: 'Save a link and it lands here. You can also share a page to Bracemark from any other app.',
      cta: true,
    };
  }
  return {
    icon: Folder,
    title: 'This list is empty',
    body: 'Add a link straight into it, or move links here from any other view.',
    cta: true,
  };
}

// Sized against the pane, not the window, and the sentence capped at `max-w-sm`
// so it keeps a readable measure on a tablet while still centring on a phone.
export function EmptyState({
  isLoading,
  variant = 'list',
}: {
  isLoading: boolean;
  variant?: 'list' | 'card';
}) {
  const { selection } = useLinksPage();

  if (isLoading) return <LinksSkeleton variant={variant} />;

  const { icon, title, body, cta } = emptyCopy(selection);

  return (
    <View className="flex-1 items-center justify-center gap-3 px-6 py-12">
      <View className="size-11 items-center justify-center rounded-full bg-muted">
        <Icon as={icon} className="size-5 text-muted-foreground" />
      </View>
      <View className="gap-1">
        <Text className="text-center text-base font-medium">{title}</Text>
        <Text className="max-w-sm text-center text-sm text-muted-foreground">{body}</Text>
      </View>
      {/* No button here, unlike web's, and `cta` is what suppresses the LINE
          rather than a control: the add affordance on this screen is the FAB
          (add-link-fab.tsx), which is rendered at screen level and is therefore
          already on top of this state. A second Add button 40px from it would be
          two controls for one verb; a sentence pointing at the one that is there
          is the honest version. */}
      {cta && <Text className="text-xs text-muted-foreground">Tap + to add your first link.</Text>}
    </View>
  );
}

// The first read, before any row exists. A skeleton in the shape of what's
// coming, not the word "Loading": the pane keeps its geometry, so the rows don't
// arrive as a jump, and a local-first read that resolves in 40ms flashes a
// silhouette of the list rather than a sentence the eye has to parse and
// discard. Mirrors each layout's real geometry closely enough to read as the
// same surface (the row's 64×40 thumbnail and two text lines; the card's banner
// over its text block) without importing their measurements — a skeleton that
// drifts by a few pixels costs nothing, and this file has no business depending
// on the item renderers.
//
// It is STATIC, where web's bones pulse. `animate-pulse` is a CSS animation
// Uniwind has no native equivalent for, and the honest alternatives both cost
// more than the effect is worth here: a Reanimated loop would run a driver for a
// surface that is usually on screen for two frames, and a JS-timer opacity
// toggle would jank on exactly the low-end device where the read is slow enough
// for this to show at all. The silhouette is doing the work either way.
//
// The bones are ONE accessibility node carrying the label, not eleven empty
// boxes: `accessible` collapses the subtree and `aria-label` gives it the
// sentence the sighted user is spared. Web achieves the same with `aria-hidden`
// bones plus an `sr-only` status line — there is no `sr-only` on native, and
// collapsing the subtree is the platform's own idiom for it.
function Bone({ className }: { className?: string }) {
  return <View className={cn('rounded bg-muted', className)} />;
}

function LinksSkeleton({ variant }: { variant: 'list' | 'card' }) {
  const count = variant === 'card' ? 6 : 8;

  return (
    <View className="flex-1 overflow-hidden">
      <View accessible aria-label="Loading links…" aria-live="polite">
        {variant === 'card' ? (
          <View className="flex-row flex-wrap p-2">
            {Array.from({ length: count }, (_, i) => (
              <View key={i} className="w-1/2 p-2">
                <View className="overflow-hidden rounded-lg border border-border">
                  <Bone className="h-24 rounded-none" />
                  <View className="gap-2 p-3">
                    <Bone className="h-3 w-16" />
                    <Bone className="h-3.5 w-full" />
                    <Bone className="h-3.5 w-2/3" />
                  </View>
                </View>
              </View>
            ))}
          </View>
        ) : (
          <View>
            {Array.from({ length: count }, (_, i) => (
              <View
                key={i}
                className="h-[4.375rem] flex-row items-center gap-3 border-b border-border pr-2 pl-4"
              >
                <Bone className="h-10 w-16 shrink-0" />
                <View className="min-w-0 flex-1 gap-2">
                  <Bone className="h-3.5 w-1/2" />
                  <Bone className="h-3 w-28" />
                </View>
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

// The "new updates" affordance — web's RefreshPill: floats over the list while
// a background sync's results are held back; pressing applies them and scrolls
// to top so the reorder lands where the user can see it.
export function RefreshPill({ show, onPress }: { show: boolean; onPress: () => void }) {
  if (!show) return null;

  return (
    // box-none so the strip passes touches through to the list; the pill
    // itself still receives its own.
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 top-2 z-10 flex-row justify-center"
    >
      <Pressable
        onPress={onPress}
        className="flex-row items-center gap-2 rounded-full bg-primary px-4 py-2 shadow-md"
      >
        <Icon as={RefreshCw} className="size-4 text-primary-foreground" />
        <Text className="text-sm font-medium text-primary-foreground">New updates</Text>
      </Pressable>
    </View>
  );
}

// Open state for an item-anchored overlay (the row menu, its Move-to dialog,
// the tag-overflow menu), reporting open/close into the hoisted engagement
// count (setMenuOpen) so a background sync won't repaint the item — moving or
// unmounting the trigger — while the overlay is open (web's useEngagedOpen,
// verbatim). Tracks its own open flag so an unmount-while-open (e.g. a layout
// switch) releases the count instead of leaking it and pinning `engaged` true
// forever; idempotent on repeated same-state calls — the count is shared, so a
// stray close must not decrement another overlay's increment. One divergence:
// @rn-primitives' dropdown Root is uncontrolled on native (no `open` prop), so
// menu callers pass only the handler to onOpenChange and ignore the returned
// state — it still exists for the callers that do control (the Move-to dialog).
export function useEngagedOpen(): [boolean, (open: boolean) => void] {
  const { setMenuOpen } = useLinksViewState();
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  useEffect(
    () => () => {
      if (openRef.current) setMenuOpen(false);
    },
    [setMenuOpen],
  );
  const handleOpenChange = (nextOpen: boolean) => {
    if (openRef.current === nextOpen) return;
    openRef.current = nextOpen;
    setOpen(nextOpen);
    setMenuOpen(nextOpen);
  };
  return [open, handleOpenChange];
}

// Flatten the live tag tree into an id → name map (shared's `treeNameMap`),
// hoisted ONCE and passed to the items (web's useTagMap rationale: a per-item
// useTags would mount one live read per item; tag renames must repaint
// immediately, never wait behind the refresh pill).
export function useTagMap(): Map<string, string> {
  const tree = useTags();
  return useMemo(() => treeNameMap(tree), [tree]);
}

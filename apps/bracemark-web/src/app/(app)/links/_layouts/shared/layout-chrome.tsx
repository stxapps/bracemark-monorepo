'use client';

// The layout's non-row chrome: the empty state, the first-read skeleton, the
// "show more" footer, and the floating "new updates" refresh pill.

import { Archive, Folder, Hash, Inbox, Layers, RefreshCw, SearchX, Trash2 } from 'lucide-react';

import { ARCHIVE_ID, DEFAULT_LIST_ID, TRASH_ID } from '@stxapps/shared';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { LinkAddSurface } from '../../_components/link-add-surface';
import { type Selection, useLinksPage } from '../../_contexts/page-provider';

// An empty pane is not one state, it's seven, and they want different words.
// "No links here yet." was true in all of them and useful in none: in Trash it
// reads as a fault, in a tag view it doesn't say how a link gets tagged, and on
// a fresh account — the one place this screen is guaranteed to be seen — it
// answers a question nobody asked instead of offering the one action available.
//
// So the copy is keyed off the same `selection` the topbar titles the view with,
// and only the views where adding a link actually lands HERE offer the add
// control (`cta`): a tag can't be assigned at creation from this button, and
// nothing is "added" to Trash or Archive, so those three explain the mechanism
// in a sentence instead of offering an action that wouldn't do what it says.
function emptyCopy(selection: Selection): {
  icon: React.ReactNode;
  title: string;
  body: string;
  cta?: boolean;
} {
  if (selection.kind === 'none') {
    return {
      icon: <SearchX />,
      title: 'No links match',
      body: 'Try fewer or different words, or clear the search to see everything again.',
    };
  }
  if (selection.kind === 'tag') {
    return {
      icon: <Hash />,
      title: 'Nothing tagged yet',
      body: 'Links get this tag from their ⋯ menu, from the editor, or from bulk edit.',
    };
  }
  if (selection.kind === 'all') {
    return {
      icon: <Layers />,
      title: 'No links saved yet',
      body: 'Every link you save shows up here, whichever list it lives in.',
      cta: true,
    };
  }
  if (selection.id === TRASH_ID) {
    return {
      icon: <Trash2 />,
      title: 'Trash is empty',
      body: 'Links you remove land here and stay until you delete them permanently.',
    };
  }
  if (selection.id === ARCHIVE_ID) {
    return {
      icon: <Archive />,
      title: 'Nothing archived',
      body: 'Archive a link when you are done with it — it leaves My List but stays saved.',
    };
  }
  if (selection.id === DEFAULT_LIST_ID) {
    return {
      icon: <Inbox />,
      title: 'No links yet',
      body: 'Save a link and it lands here. The browser extension and the mobile app save into this list too.',
      cta: true,
    };
  }
  return {
    icon: <Folder />,
    title: 'This list is empty',
    body: 'Add a link straight into it, or move links here from any other view.',
    cta: true,
  };
}

// Sized against the pane, not the viewport, and capped so the sentence keeps a
// readable measure on a wide monitor while still centring on a phone.
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
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5"
      >
        {icon}
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-base font-medium">{title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      </div>
      {cta && (
        <div className="mt-1">
          <LinkAddSurface prominent />
        </div>
      )}
    </div>
  );
}

// The first read, before any row exists. A skeleton in the shape of what's
// coming, not the word "Loading": the pane keeps its geometry, so the rows don't
// arrive as a jump, and a local-first read that resolves in 40ms flashes a
// silhouette of the list rather than a sentence the eye has to parse and
// discard. Mirrors each layout's real geometry closely enough to read as the
// same surface (the list row's 64×40 thumbnail and two text lines; the card's
// 12:7 banner over its text block, capped and centred like the real one) without
// importing their measurements — a skeleton that drifts by a few pixels costs
// nothing, and this file has no business reaching into a layout's numbers.
//
// `aria-hidden` on the bones, with one polite status line behind it: a screen
// reader should hear "Loading links", not eleven empty boxes.
function Bone({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-muted', className)} />;
}

function LinksSkeleton({ variant }: { variant: 'list' | 'card' }) {
  // Enough CARDS to fill the widest pane, not exactly one pane's worth — the
  // grid is `auto-fill` (below), so its column count is a fact about the
  // container that no value here can know, while the root is `h-full
  // overflow-hidden`, so a surplus card is CLIPPED rather than scrolled. That
  // asymmetry is the whole rule: too many costs some aria-hidden divs for the
  // ~40ms this is up, too few leaves the bottom of the pane bare. Measured at a
  // 900px-tall pane, the old 6 showed two rows at three columns and fell to a
  // single row by seven — a strip of bones across the top of a wide monitor and
  // nothing under it. 24 holds three rows out to nine columns (a ~3000px pane)
  // and four through the usual 1000-2400, while the ~20 a one-column popup can't
  // reach are clipped at no visual cost.
  //
  // bracemark-expo spells the same intent as `columns * 3` (features/links/
  // shared.tsx) and can be exact, but only because RN has no `auto-fill`: its
  // grid must be handed a column count for the cell WIDTH anyway, so the count
  // rides along free. Here that number would have to be measured, and measured
  // off a container that does not exist yet on the frame this renders — the
  // reason card-layout.tsx falls back to DEFAULT_COLUMNS at that moment.
  const count = variant === 'card' ? 24 : 8;

  return (
    // `scrollbar-gutter-stable` on a box that can never scroll, which looks wrong
    // until you remember what this element IS: a prediction of the scroller it
    // stands in for. Both real scrollers reserve the gutter permanently
    // (list-layout.tsx and card-layout.tsx, `overflow-y-auto
    // scrollbar-gutter-stable`), so on a classic-scrollbar platform their content
    // box is 15px narrower than this one would otherwise be — and the card grid
    // resolves its column count from that width via `auto-fill`. Without this the
    // skeleton can lay out two columns immediately before the real grid lays out
    // one. `stable` does reserve the strip under `overflow-hidden` (verified in
    // Chrome; the gutter is about being a scroll container, not about painting a
    // scrollbar), and an unpainted strip costs the skeleton nothing.
    <div
      className="h-full scrollbar-gutter-stable overflow-hidden"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">Loading links…</span>
      {variant === 'card' ? (
        <div
          aria-hidden
          className="grid gap-4 p-4"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(18.75rem, 1fr))' }}
        >
          {Array.from({ length: count }, (_, i) => (
            <div
              key={i}
              className="mx-auto w-full max-w-105 overflow-hidden rounded-lg border border-border"
            >
              <Bone className="aspect-12/7 rounded-none" />
              <div className="flex flex-col gap-2 p-3">
                <Bone className="h-3 w-16" />
                <Bone className="h-3.5 w-full" />
                <Bone className="h-3.5 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div aria-hidden>
          {Array.from({ length: count }, (_, i) => (
            <div
              key={i}
              className="flex h-17.5 items-center gap-3 border-b border-border pr-2 pl-4"
            >
              <Bone className="h-10 w-16 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Bone className="h-3.5 w-1/2" />
                <Bone className="h-3 w-28" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ShowMoreProps {
  hasMore: boolean;
  showMore: () => void;
}

export function ShowMore({ hasMore, showMore }: ShowMoreProps) {
  if (!hasMore) return null;

  return (
    <div className="flex justify-center py-4">
      <Button variant="outline" size="sm" onClick={showMore}>
        Show more
      </Button>
    </div>
  );
}

// The "new updates" affordance: a floating pill shown when a background sync has
// results held back (useLinks `hasPending`). It must be placed inside a
// `relative` wrapper that does NOT scroll (a sibling of the scroll container), so
// it stays pinned to the top of the pane instead of riding the scrolled content.
// Clicking applies the held results AND scrolls the layout to top, so the
// reorder lands where the user can see it rather than shifting them mid-list.
interface RefreshPillProps {
  show: boolean;
  onClick: () => void;
}

export function RefreshPill({ show, onClick }: RefreshPillProps) {
  if (!show) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
      <Button size="sm" onClick={onClick} className="pointer-events-auto rounded-full shadow-md">
        <RefreshCw data-icon="inline-start" className="size-4" />
        New updates
      </Button>
    </div>
  );
}

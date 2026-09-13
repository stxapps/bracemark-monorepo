'use client';

// The bar above the main pane, and the only way out of settings.
//
// IT ALIGNS WITH THE CONTENT. Its inner row is the same `max-w-2xl` +
// `px-4 md:px-6` column the sections render into (SettingsPane), so "Settings"
// sits directly above the section's own title on one left edge. Before, the bar's
// title started at the pane's left padding while the content was centred ~180px
// to its right, which put the page's two headings on two different axes — the
// most visible thing wrong with this screen at desktop width.
//
// The inset is written once, in SettingsPane, and mirrored here; that file says
// why it steps at `md` and why no section may override it. Below `md` it is the
// SectionMenu rather than the label that has to land on it, which is what that
// button's `-ml-2` is for — see there.
//
// IT IS STICKY, INSIDE THE SCROLL CONTAINER. This bar used to be a SIBLING of the
// scrolling `main`, and a sibling cannot stay aligned with it: `main` is the
// scroll container, so its content box is the frame MINUS the scrollbar, and the
// two `mx-auto`s then centre about two different midpoints. The section landed
// half a scrollbar (~7px) left of "Settings" — with matching padding on both, at
// every width past ~912px, and unfixable from the inset because it isn't an inset
// problem. So the bar moved inside the scroller (layout.tsx), where there is one
// box and one midpoint. `bg-background` is load-bearing now: content scrolls
// BEHIND this bar rather than being clipped at its edge.
//
// "Settings" IS NOT A HEADING. It was an `h1` set at `text-lg font-semibold`,
// above a section title at `text-xl` — a document whose h1 rendered smaller than
// its own h2. Rather than pick a bigger size for a word that never changes, it
// stopped being a heading: it names the surface, which is chrome, so it's a
// `span` and the SECTION title is the page's `h1` (see SettingsHeader). The
// outline that leaves is the honest one — `/settings/misc` is a page called
// "Misc." whose blocks are Link layout, Link sort, Theme, App lock.
//
// Below `md` the left slot becomes the section menu, because the sidebar that
// normally holds it is hidden at that width. Same sections, same order, same
// source (`SETTINGS_SECTIONS`) — a dropdown is just the shape a 15rem rail takes
// when there isn't 15rem to give it.

import { useEffect, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@stxapps/web-ui/components/ui/dropdown-menu';
import { cn } from '@stxapps/web-ui/lib/utils';

import { SETTINGS_SECTIONS } from '../sections';

import { readLinksReturn } from '@/lib/links-return';

function SectionMenu() {
  const pathname = usePathname();
  const active = SETTINGS_SECTIONS.find((s) => pathname === `/settings/${s.id}`);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* `-ml-2` lands this button's LEADING GLYPH on the pane's content inset,
            which is what the bar has to align below `md` (the label can't — the
            icon is in front of it). The arithmetic: the row's `pl-4` puts the
            button box at 16, this pulls it to 8, and `size="sm"` trims its `px-3`
            to `pl-2` for an `inline-start` icon, so the glyph starts back at 16 —
            the pane's own narrow inset. It is 1px out in practice, because the
            Button base carries `border border-transparent`; measured, the glyph
            sits at 17 against an `h1` at 16. Left alone deliberately — an
            `-ml-[9px]` would buy a pixel of a glyph-against-text edge that no
            lucide icon is flush to anyway, at the cost of a magic number. Above
            `md` this button is gone and the `Settings` span aligns exactly. */}
        <Button variant="ghost" size="sm" className={cn('-ml-2 gap-1.5')}>
          {/* `data-icon` sits on a wrapper rather than on the icon itself: the
              node comes from the SETTINGS_SECTIONS table, which also renders it
              in the rail and in this menu's items, and whether it leads a
              button is this call site's business, not the table's. `contents`
              means the wrapper generates no box, so the svg stays the Button's
              own flex item. Conditional so an unmatched path — which falls back
              to a bare "Settings" with no icon — doesn't leave an empty marker
              claiming the tighter padding. */}
          {active?.icon ? (
            <span data-icon="inline-start" className={cn('contents')}>
              {active.icon}
            </span>
          ) : null}
          <span className={cn('truncate font-semibold')}>{active?.label ?? 'Settings'}</span>
          <ChevronDown data-icon="inline-end" className={cn('size-4 text-muted-foreground')} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={cn('w-56')}>
        {SETTINGS_SECTIONS.map((section) => (
          <DropdownMenuItem key={section.id} asChild>
            <Link href={`/settings/${section.id}`}>
              {section.icon}
              <span className={cn('flex-1')}>{section.label}</span>
              {/* Marks where you are, so the menu doubles as the "you are here"
                  the hidden sidebar would otherwise have shown. */}
              {section.id === active?.id ? <Check className={cn('size-4')} /> : null}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Where the ✕ goes: the links view Settings was opened from, or the bare
// `/links` when this tab hasn't been there. It used to be `/links` always, which
// silently dropped whatever list, tag, or search was on screen — the round trip
// through Settings (to add a list, to change the sort) reset the page you came
// from. The links page records the view; lib/links-return.ts holds the key and
// says why it's session-scoped.
//
// Read in an effect rather than during render because sessionStorage doesn't
// exist on the server: the first paint is the `/links` default on both sides —
// so there's nothing for hydration to mismatch — and the stored href swaps in on
// mount, long before anyone can click. That also keeps the ✕ a real `<a>` with a
// real href, which a button + router.push would not be.
//
// Deliberately NOT validated here against the current lists/tags. Returning to a
// view whose list was just deleted IS handled — by the links page itself
// (page-provider's isStaleSelection), which is also what a stale bookmark or a
// back-button entry hits. One rule, in the place that owns the URL, instead of a
// second copy here that would only cover the ✕.
function useCloseHref(): string {
  const [href, setHref] = useState('/links');
  useEffect(() => setHref(readLinksReturn()), []);
  return href;
}

export function Topbar() {
  const closeHref = useCloseHref();

  // `sticky` is still a positioned element, so the absolutely-placed close button
  // below anchors to this header exactly as it did under the `relative` it
  // replaced.
  //
  // `h-14` IS THE FLOOR UNDER THE SCROLLER'S `scroll-pt-18` (layout.tsx), because
  // a sticky bar inside a scroll container hides that band from every
  // scrollIntoView that aims at the top of it — SettingsNotice's error scroll
  // landed under this bar until the padding cleared it. The padding is this 56
  // plus 16 of air, so a notice arrives a step below the hairline instead of
  // welded to it; layout.tsx carries that half. Grow this bar and the padding
  // MUST grow with it; nothing will report the pair drifting apart.
  return (
    <header className={cn('sticky top-0 z-10 h-14 border-b border-border bg-background')}>
      {/* The label rides the content column; the close button does NOT. It is a
          window control for the whole pane, so it stays in the pane's own corner
          where one is looked for — inside the column it read as a stray glyph
          floating mid-pane with 340px of empty bar to its right. `pr-14` keeps the
          mobile section menu from running under it. */}
      <div
        className={cn(
          'mx-auto flex h-full w-full max-w-2xl items-center pr-14 pl-4 md:pr-6 md:pl-6',
        )}
      >
        <div className={cn('min-w-0 flex-1')}>
          <div className={cn('md:hidden')}>
            <SectionMenu />
          </div>
          <span
            className={cn('hidden truncate text-sm font-medium text-muted-foreground md:block')}
          >
            Settings
          </span>
        </div>
      </div>

      <Button
        asChild
        variant="ghost"
        size="icon-sm"
        aria-label="Close settings"
        className={cn('absolute top-1/2 right-4 -translate-y-1/2')}
      >
        <Link href={closeHref}>
          <X className={cn('size-4')} />
        </Link>
      </Button>
    </header>
  );
}

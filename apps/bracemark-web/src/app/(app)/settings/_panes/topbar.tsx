'use client';

// The bar above the main pane, and the only way out of settings.
//
// IT ALIGNS WITH THE CONTENT. Its inner row is the same `max-w-2xl` + `px-6`
// column the sections render into (SettingsPane), so "Settings" sits directly
// above the section's own title on one left edge. Before, the bar's title started
// at the pane's left padding while the content was centred ~180px to its right,
// which put the page's two headings on two different axes — the most visible
// thing wrong with this screen at desktop width.
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

function SectionMenu() {
  const pathname = usePathname();
  const active = SETTINGS_SECTIONS.find((s) => pathname === `/settings/${s.id}`);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={cn('-ml-2 gap-1.5')}>
          {active?.icon}
          <span className={cn('truncate font-semibold')}>{active?.label ?? 'Settings'}</span>
          <ChevronDown className={cn('size-4 text-muted-foreground')} />
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

export function Topbar() {
  return (
    <header className={cn('relative h-14 shrink-0 border-b border-border')}>
      {/* The label rides the content column; the close button does NOT. It is a
          window control for the whole pane, so it stays in the pane's own corner
          where one is looked for — inside the column it read as a stray glyph
          floating mid-pane with 340px of empty bar to its right. `pr-14` keeps the
          mobile section menu from running under it. */}
      <div className={cn('mx-auto flex h-full w-full max-w-2xl items-center pr-14 pl-6 md:pr-6')}>
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
        <Link href="/links">
          <X className={cn('size-4')} />
        </Link>
      </Button>
    </header>
  );
}

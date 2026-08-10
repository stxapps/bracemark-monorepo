'use client';

// The rail, below `md`, where there is no room for a rail: the same
// `SidebarBody` in a sheet that slides in over the pane (sidebar.tsx explains
// why this nav gets a panel where the settings rail gets a dropdown).
//
// ITS TRIGGER IS THE PAGE TITLE. The topbar's heading already names the thing
// the rail selects — "My List", "Archive", a tag — so making it the door to the
// rail costs no width and needs no explaining: the word for where you are is the
// control for going elsewhere. That's what lets the narrow topbar keep its
// actions at one 56px row instead of spending a slot on a hamburger nobody has
// to look for. The chevron is the affordance; `aria-expanded` and
// `aria-haspopup="dialog"` are what say it to a screen reader.
//
// Selecting a list/tag dismisses the sheet (SidebarBody's `onNavigate`) — the
// point of the tap was the links, not the panel. Expanding a subtree does not.
//
// Mounted only while OPEN (Radix unmounts closed content), so in the common
// case — the drawer shut, or a desktop that never opens it — there is exactly
// one copy of the trees subscribed to the store, not two.

import { useCallback, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';

import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@stxapps/web-ui/components/ui/sheet';
import { cn } from '@stxapps/web-ui/lib/utils';

import { SidebarBody } from './sidebar';

export function SidebarDrawer({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  // Identity-stable so SidebarBody's context value doesn't change every render
  // of this component.
  const close = useCallback(() => setOpen(false), []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-haspopup="dialog"
          className={cn(
            '-mx-2 flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 transition-colors',
            'hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
        >
          {/* Same type as the `md:` heading it stands in for, so the title
              doesn't change size when the frame does. */}
          <span className="truncate text-lg font-semibold">{label}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </SheetTrigger>
      {/* `w-72` over the sheet's default `w-3/4`: the trees want a predictable
          measure (they indent 16px per level), and three quarters of a 320px
          phone is narrower than the 15rem rail this stands in for.
          `aria-describedby={undefined}` because there is no description to point
          at — a nav needs a name, not a paragraph. */}
      <SheetContent
        side="left"
        showCloseButton={false}
        aria-describedby={undefined}
        className="w-72 max-w-[85vw]"
      >
        <SheetTitle className="sr-only">Lists and tags</SheetTitle>
        <SidebarBody
          onNavigate={close}
          action={
            <SheetClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close navigation">
                <X className="size-4" />
              </Button>
            </SheetClose>
          }
        />
      </SheetContent>
    </Sheet>
  );
}

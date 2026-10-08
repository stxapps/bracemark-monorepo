import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { CheckIcon, SearchIcon } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@stxapps/web-ui/components/ui/dialog';
import { InputGroup, InputGroupAddon } from '@stxapps/web-ui/components/ui/input-group';
import { cn } from '@stxapps/web-ui/lib/utils';

// `rounded-2xl`, matching PopoverContent and DropdownMenuSubContent — the two
// things this is dropped into with their own padding stripped (`p-0`), so this
// root IS the visible panel and its corner is the panel's corner. This used to
// be `rounded-4xl` with both callers spelling `rounded-2xl` over it locally; the
// value now lives here and those overrides are gone.
//
// Not cosmetic, because `overflow-hidden` applies the corner to the CONTENT: a
// row's hover rect starts 4px down and 8px in, and a 32px arc is still ~16px in
// from the side at that height, so it would shear the top corners off the first
// row of an input-less picker (either "Move to" menu). A 16px arc is ~5px in
// there — clear of the row and of its own `rounded-xl`. Inside CommandDialog
// it's the dialog that's `rounded-4xl`; this one being tighter only clips less,
// and both are `bg-popover`, so no seam shows.
function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex size-full flex-col overflow-hidden rounded-2xl bg-popover p-1 text-popover-foreground',
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = 'Command Palette',
  description = 'Search for a command to run...',
  children,
  className,
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {/* This is the one dialog in the package that ISN'T viewport-centred, so
          DialogContent's `max-h-(--dialog-max-h)` — which subtracts twice the
          larger inset because a centred box splits its clearance across both
          edges — is the wrong cap here and is overridden. A palette hangs from a
          FIXED top edge, so all of its slack is below it: what it may grow to is
          the distance from that edge to the bottom of the safe area, and the top
          inset doesn't enter into it at all (a third of the viewport clears any
          notch on anything wider than it is tall, and in landscape — the short
          case — the iPhone top inset is 0 and the notch becomes a side one).

          `top-[33.3333dvh]` rather than the `top-1/3` this used to carry: a
          percentage on a `fixed` box resolves against the initial containing
          block, which is the LARGE viewport (URL bar retracted), while the cap
          below is in `dvh`. Two different references for the two halves of one
          sum is how a box ends up taller than the room it was measured for; this
          makes both `dvh` (docs/safe-area.md, _applying safe area_, on why every
          viewport unit here is `dvh`).

          `grid-rows-[minmax(0,1fr)]` is what lets the cap actually reach
          CommandList: the base is a grid, and a grid row's automatic minimum
          size would otherwise refuse to shrink below its content, so the box
          would honour the max-height by clipping (it is `overflow-hidden`)
          rather than by handing the list less room. With the row free to shrink,
          `Command`'s `size-full overflow-hidden` passes the squeeze down to
          CommandList, whose own `overflow-y-auto` already zeroes ITS automatic
          minimum — so `max-h-72` becomes the preferred height and the real one
          is whatever is left, which is the web equivalent of the cap/`shrink`
          pair expo's dialogs use.

          Note this component currently has no caller in the workspace —
          ListCommand and TagsCommand render `Command` bare inside a Popover or a
          Sheet. It stays correct because it's exported API, and because the
          shape it wants is the least obvious of the three. */}
      <DialogContent
        className={cn(
          'top-[33.3333dvh] max-h-[calc(66.6667dvh-var(--env-safe-area-inset-bottom)-1rem)] translate-y-0 grid-rows-[minmax(0,1fr)] overflow-hidden rounded-4xl! p-0',
          className,
        )}
        showCloseButton={showCloseButton}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  onKeyDown,
  autoCapitalize = 'none',
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  // The wrapper takes a full `p-1`. Its bottom inset is the gap down to the
  // first row (CommandList has no vertical padding of its own, so without it the
  // first row butts against the field), and its horizontal inset is what puts
  // this field's border box on the same 8px from the panel edge as a row's hover
  // rect — 4 from Command plus 4 here, matched by CommandList's `px-1`. Removing
  // it to align them the other way, with both at 4px, is the wrong half of the
  // fix: it leaves `ring-[3px]` on focus with nothing to breathe into before
  // Command's `overflow-hidden` edge, and nothing at all under
  // move-to-surface.tsx, which passes `p-0` on Command.
  return (
    <div data-slot="command-input-wrapper" className="p-1">
      <InputGroup className="h-9 bg-input/30">
        <CommandPrimitive.Input
          // cmdk already disables autocomplete, autocorrect and spellcheck.
          // Its raw input bypasses our Input, so set the remaining hint here.
          autoCapitalize={autoCapitalize}
          data-slot="command-input"
          className={cn(
            // `text-base md:text-sm` — the control type step (input.tsx). This one
            // is not cosmetic: cmdk autofocuses this field when either picker
            // opens, so at a flat 14px it was an iOS auto-zoom on every tap of a
            // list or tag picker on a phone.
            'w-full text-base outline-hidden disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
            className,
          )}
          {...props}
          // A text field owns its caret keys. This one gets dropped into hosts
          // that listen for them: Radix closes a dropdown SUBMENU on ArrowLeft
          // from anywhere inside it — this field included — so stepping back
          // through a half-typed name threw the name away with the menu
          // (ListCommand, in the row menu's Move to and the Lists settings
          // reparent menu). Keep the key here while there is a caret to move. At
          // the very start it has nothing left to do in the field, so it goes on
          // up and closes the submenu: still the keyboard's way back to the
          // parent menu.
          //
          // Here rather than in ListCommand, where it began, because it is a
          // fact about the field and not about one picker: TagsCommand renders
          // the same field, and the day it gains a submenu host nothing — no
          // lint, no type, no spec of its own hosts — would say it had lost the
          // key. Harmless everywhere else: the only other listener above this
          // field is cmdk's own root, which does nothing with ArrowLeft.
          //
          // ArrowLeft ONLY. cmdk also takes Home and End from this field (first
          // and last row), and that is left alone on purpose — it costs a caret
          // jump, not the typed name.
          onKeyDown={(event) => {
            onKeyDown?.(event);
            const { selectionStart, selectionEnd } = event.currentTarget;
            if (event.key === 'ArrowLeft' && (selectionStart !== 0 || selectionEnd !== 0)) {
              event.stopPropagation();
            }
          }}
        />
        <InputGroupAddon>
          <SearchIcon className="size-4 shrink-0 opacity-50" />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

// `scrollbar-gutter-stable` because THIS is the scroller a filter box drives: the
// only two users are ListCommand and TagsCommand, whose input prunes the rows on
// every keystroke, and `max-h-72` (288px) is ~9 rows — right where ListCommand's
// own SEARCH_THRESHOLD of 10 lets the input appear at all. So the first character
// typed almost always takes the list from overflowing to not, and on a
// classic-scrollbar platform that widens the content box by 15px mid-keystroke.
// Every row is `truncate` (and ListCommand's filtered rows prepend an ancestor
// path), so the jump RE-TRUNCATES row text rather than merely moving it — the
// links sidebar's symptom, in the surface where filtering is the whole point.
//
// The `no-scrollbar` that used to sit here was DEAD: no such utility is defined
// in web-ui/styles.css, in any app stylesheet, or in Tailwind core, so it emitted
// nothing and these lists have always shown an ordinary scrollbar. Its position
// at the head of the class list was the tell — prettier-plugin-tailwindcss hoists
// classes it can't resolve (docs/theme.md, _the token shim_). Removing it changes no
// rendered behaviour. If hiding the scrollbar was ever the intent, that wants a
// real `@utility no-scrollbar` in styles.css — but a filterable list with no
// scrollbar also loses its only "there is more below" cue, which is why this
// keeps the scrollbar and merely stops it from moving the rows.
//
// `px-1` puts a row's hover rect at the same 8px from the panel edge as the
// filter input's border box above it (CommandInput, which explains the pair).
// Horizontal only, deliberately: the vertical spacing here is load-bearing
// OUTSIDE this file — move-to-surface.tsx's sheet derives its header's `pb-4`
// from where the first row's ink lands, and a `pt` here would move that by 4px
// without touching the comment that derives it.
function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        'max-h-72 scroll-py-1 scrollbar-gutter-stable overflow-x-hidden overflow-y-auto px-1 outline-none',
        className,
      )}
      {...props}
    />
  );
}

// `text-muted-foreground` is a local change to the registry's `py-6 text-center
// text-sm`, which paints this at full foreground — louder than the rows it
// stands in for, and the only secondary line in the app that wasn't muted. The
// CENTRING is the registry's and is worth keeping: it says "state of the panel",
// where a line at the rows' own inset would read as a row. Both halves are
// ported to expo's three picker bodies, which had it left-aligned and
// row-shaped — on that platform a non-pressable line wearing row geometry sits
// among Pressables that light up under a finger (docs/theme.md, _ported_).
function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn('py-6 text-center text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('my-1 h-px bg-border/50', className)}
      {...props}
    />
  );
}

// The highlight MUST be spelled `data-[selected=true]:`, never the bare
// `data-selected:`. cmdk renders `data-selected={!!selected}` and React
// stringifies false-valued `data-*`, so an unselected row still carries
// `data-selected="false"` — and the bare variant compiles to a presence
// selector, `[data-selected]`, which matches it. The symptom is every row
// wearing the highlight at once (so no row looks picked, and there appears to be
// no hover response), with no lint or type error. The pointer highlight IS this
// same attribute — cmdk's onPointerMove selects — so no separate `hover:` rule.
function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex cursor-default items-center gap-2 rounded-xl px-3 py-2 text-sm outline-hidden select-none in-data-[slot=dialog-content]:rounded-2xl data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-muted data-[selected=true]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[selected=true]:*:[svg]:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        // Bracket form for the same reason as CommandItem's highlight.
        'ml-auto text-xs tracking-widest text-muted-foreground group-data-[selected=true]/command-item:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};

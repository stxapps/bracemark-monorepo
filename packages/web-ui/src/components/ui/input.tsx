import * as React from 'react';

import { cn } from '@stxapps/web-ui/lib/utils';

// THE CONTROL TYPE STEP — `text-base` below `md`, `text-sm` at or above it. This
// file establishes it and four other controls now match: textarea.tsx,
// list-select.tsx and tags-field.tsx (both combobox triggers) and command.tsx's
// CommandInput, the filter field those two pickers open.
//
// The step is shadcn's and its reason is iOS Safari: focusing a text field whose
// computed size is under 16px zooms the page, so on a phone the VALUE cannot
// shrink and only the label can — which is what label.tsx's `dense` tier is for.
// So `md:` here is a proxy for "touch phone", NOT a statement about how much room
// there is, and that is why the other four had to join it. Left at a flat
// `text-sm` they put 14px pickers beside a 16px field in one form on a phone, and
// CommandInput was the sharp end: a real text input at 14px, autofocused, sitting
// inside two pickers whose triggers exist at 16px to avoid that exact zoom.
//
// A DOCUMENT THAT IS NARROW WITHOUT BEING A PHONE breaks the proxy, and both of
// bracemark-extension's are one: neither the 360px toolbar popup nor the options
// page (no host embeds it at 768px) ever matches `md:`, so all five controls took
// the phone branch on a desktop, with a mouse and no zoom to prevent. That app
// pins them back in a single rule — `apps/bracemark-extension/styles/globals.css`
// — which names each selector. **A new control that joins the step here has to be
// added there too**, and nothing catches the omission: no lint error, no type
// error, no failing test, just a 16px field in a 360px popup.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-4xl border border-input bg-input/30 px-3 py-1 text-base transition-colors outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
}

export { Input };

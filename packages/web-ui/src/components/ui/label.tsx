import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Label as LabelPrimitive } from 'radix-ui';

import { cn } from '@stxapps/web-ui/lib/utils';

// `font-normal`, where shadcn ships `font-medium`. A form label names the field
// it sits above; it isn't competing with the value for attention, and at 14px
// over an Input that's 16px until `md:` (input.tsx) the extra weight read as
// shouting. Position and the size gap carry the distinction instead. It's the
// same direction the rest of this kit already took upstream's type — DialogTitle
// and SheetTitle are `text-base font-medium` here against shadcn's `text-lg
// font-semibold` — so a `shadcn add label` overwrite has to be re-applied.
//
// Labels that play a TITLE role rather than a field-name role opt back up at the
// call site: a SettingsRow's title (settings-kit wraps plain-text titles in
// `font-medium` at the pane's inherited 16, so a Label-bearing row overrides BOTH
// axes — `text-base font-medium` — or that one row renders lighter and smaller
// than every other row's), and the headings above a radio list whose own option
// rows are medium (weight only; those rows are Label-wrapped too, so the whole
// group sits at `text-sm` together). Those overrides are load-bearing — dropping
// one demotes a heading below the options under it. Everything else inherits this
// and should not restate a weight.
//
// TWO DENSITIES, and the point of making them a variant rather than a convention
// is that there is no way to spell a third without noticing:
//
//   standard — `text-sm`, foreground, over an `h-9` control. Full-page forms that
//     aren't fighting for room: the settings sections, the auth forms.
//   dense — `text-xs`, muted, over an `h-8`/`h-9` control. Compact editing
//     surfaces: the link editors (add sheet, edit dialog, bulk tags, the browser
//     extension's popup) and the advanced-search panel. The label reads as a
//     caption against its value rather than a peer of it — which matters most in
//     the add sheet, where the Input is 16px on a phone (below that iOS zooms on
//     focus, so the VALUE can't shrink and only the label can move).
//
// bracemark-expo's own field labels are `text-xs text-muted-foreground` already
// (link-add-screen.tsx's Field helper), so dense is also what puts the two
// clients' add forms on the same footing.
const labelVariants = cva(
  'flex items-center gap-2 leading-none font-normal select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
  {
    variants: {
      density: {
        standard: 'text-sm',
        dense: 'text-xs text-muted-foreground',
      },
    },
    defaultVariants: {
      density: 'standard',
    },
  },
);

function Label({
  className,
  density,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root> & VariantProps<typeof labelVariants>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(labelVariants({ density }), className)}
      {...props}
    />
  );
}

export { Label };

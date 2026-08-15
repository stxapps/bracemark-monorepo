// The Field system — shadcn's form-layout kit, vendored. `Field` is the column
// (label, control, description, error) and the rest are its slots.
//
// WHAT `FieldLabel` ADDS OVER `Label` — it wraps label.tsx rather than competing
// with it, and everything it adds is meaningful only inside a `Field`:
//
//   - `data-slot="field-label"`, which the wrapper targets from outside
//     (`*:data-[slot=field-label]:flex-auto`, horizontal/responsive orientations)
//   - `group-data-[disabled=true]/field:opacity-50` — disabled cascades from the
//     Field, not from the control
//   - `has-[>[data-slot=field]]:rounded-xl … border` — the pattern where the label
//     WRAPS a whole field card, which is how a checkbox/radio row is built
//   - and via `Field`'s own `data-[invalid=true]:text-destructive`, one attribute
//     on the wrapper colours label and description together
//
// So the boundary is COMPOSITION, not `<form>` vs not — a reading the code
// disproves in both directions. link-add-surface's real `<form>` uses a bare
// `Label` with its own column; the advanced-search panel that uses `FieldLabel`
// is a div inside a popover (search-bar.tsx's only `<form>` is the basic box
// below it).
//
// `FieldLabel` takes Label's props, so `density` (label.tsx — the standard/dense
// tiers) passes straight through it; the advanced-search panel is the one caller
// that uses it.
//
// Reach for this kit when you want the invalid/disabled cascade and the
// description/error slots: the auth forms (create-account-form, sign-in-form) are
// the reference use, and they carry no class overrides at all, which is the sign
// it's being used as designed. A plain `Label` over an `Input` in a
// `flex flex-col gap-1.5` stays a deliberate alternative, not a lapse — it's what
// the link editors and the settings sections use, and migrating them here would
// buy machinery they don't need.
//
// Which makes `NewPasswordField` (components/auth/) the one thing that carries the
// kit INTO Settings, and it's the boundary above rather than an exception to it:
// that component is rendered by create-account and by Settings → change password
// both, it wants the `data-invalid` cascade, and a vertical `Field` is `flex-col
// gap-2` — exactly the column it replaced there, so nothing on that screen moved.
// A shared component picks one spelling; the surfaces around it keep theirs.

import { useMemo } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { Label } from '@stxapps/web-ui/components/ui/label';
import { Separator } from '@stxapps/web-ui/components/ui/separator';
import { cn } from '@stxapps/web-ui/lib/utils';

function FieldSet({ className, ...props }: React.ComponentProps<'fieldset'>) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn(
        'flex flex-col gap-6 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3',
        className,
      )}
      {...props}
    />
  );
}

function FieldLegend({
  className,
  variant = 'legend',
  ...props
}: React.ComponentProps<'legend'> & { variant?: 'legend' | 'label' }) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        'mb-3 font-medium data-[variant=label]:text-sm data-[variant=legend]:text-base',
        className,
      )}
      {...props}
    />
  );
}

// `gap-6`, not the vendored `gap-7` — the one value in this file changed from
// stock. The auth cards are the only callers, and 28px inside the group was wider
// than every step OUT of it: 24px from the submit button down to LegalConsent
// (`mt-6`), 24px from there to the card's hairline (Card's own `gap-6`), 24px
// below it to the alt action. Fine print about the page sitting tighter to the
// button than the form's own fields sit to each other is backwards, and 28-vs-24
// is too small a delta to read as a tier anyway — it bought no hierarchy, just an
// odd value. At `gap-6` the whole card is one 12/24 scale: 12 inside a Field
// (`gap-3` — label, control, message, the tier that means "belongs to this
// control"), 24 between every block above it. Grouping is carried by type size,
// the filled button and the hairline instead.
//
// The submit button rides this same 24 as a plain `Field`, deliberately. It must
// not be tighter than the field-to-field gap: it acts on EVERY field above it, and
// proximity would read it as a third control of the last one.
function FieldGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        'group/field-group @container/field-group flex w-full flex-col gap-6 data-[slot=checkbox-group]:gap-3 *:data-[slot=field-group]:gap-4',
        className,
      )}
      {...props}
    />
  );
}

const fieldVariants = cva('group/field flex w-full gap-3 data-[invalid=true]:text-destructive', {
  variants: {
    orientation: {
      // `gap-2`, overriding the base `gap-3` — vertical ONLY, because the base
      // gap runs sideways in the other two orientations (checkbox to its label),
      // where 8px is cramped. Stock 12px inside a Field against the group's 24px
      // between them is a 1:2 ratio: a label sits nearly as close to the control
      // ABOVE it as to its own, which is what dissolves the grouping. 8px makes it
      // 1:3. Both other surfaces in this repo had already gone tighter on their
      // own rather than take the stock value — settings' change-password form runs
      // a standard Label over an Input at `gap-2`, and the advanced-search panel
      // overrides every Field to `gap-1` (search-bar.tsx, whose note makes this
      // same ratio argument). This puts the auth forms on that footing instead of
      // leaving them the one holdout.
      vertical: 'flex-col gap-2 *:w-full [&>.sr-only]:w-auto',
      horizontal:
        'flex-row items-center has-[>[data-slot=field-content]]:items-start *:data-[slot=field-label]:flex-auto has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
      responsive:
        'flex-col *:w-full @md/field-group:flex-row @md/field-group:items-center @md/field-group:*:w-auto @md/field-group:has-[>[data-slot=field-content]]:items-start @md/field-group:*:data-[slot=field-label]:flex-auto [&>.sr-only]:w-auto @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
    },
  },
  defaultVariants: {
    orientation: 'vertical',
  },
});

function Field({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof fieldVariants>) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  );
}

function FieldContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-content"
      className={cn('group/field-content flex flex-1 flex-col gap-1 leading-snug', className)}
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="field-label"
      className={cn(
        'group/field-label peer/field-label flex w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-50 has-data-checked:border-primary/30 has-data-checked:bg-primary/5 has-[>[data-slot=field]]:rounded-xl has-[>[data-slot=field]]:border *:data-[slot=field]:p-4 dark:has-data-checked:border-primary/20 dark:has-data-checked:bg-primary/10',
        'has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col',
        className,
      )}
      {...props}
    />
  );
}

function FieldTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-label"
      className={cn(
        'flex w-fit items-center gap-2 text-sm font-medium group-data-[disabled=true]/field:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

function FieldDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        'text-left text-sm leading-normal font-normal text-muted-foreground group-has-data-horizontal/field:text-balance [[data-variant=legend]+&]:-mt-1.5',
        'last:mt-0 nth-last-2:-mt-1',
        '[&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary',
        className,
      )}
      {...props}
    />
  );
}

function FieldSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  children?: React.ReactNode;
}) {
  return (
    <div
      data-slot="field-separator"
      data-content={!!children}
      className={cn(
        'relative -my-2 h-5 text-sm group-data-[variant=outline]/field-group:-mb-2',
        className,
      )}
      {...props}
    >
      <Separator className="absolute inset-0 top-1/2" />
      {children && (
        <span
          className="relative mx-auto block w-fit bg-background px-2 text-muted-foreground"
          data-slot="field-separator-content"
        >
          {children}
        </span>
      )}
    </div>
  );
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: React.ComponentProps<'div'> & {
  errors?: Array<{ message?: string } | undefined>;
}) {
  const content = useMemo(() => {
    if (children) {
      return children;
    }

    if (!errors?.length) {
      return null;
    }

    const uniqueErrors = [...new Map(errors.map((error) => [error?.message, error])).values()];

    if (uniqueErrors?.length === 1) {
      return uniqueErrors[0]?.message;
    }

    return (
      <ul className="ml-4 flex list-disc flex-col gap-1">
        {uniqueErrors.map((error, index) => error?.message && <li key={index}>{error.message}</li>)}
      </ul>
    );
  }, [children, errors]);

  if (!content) {
    return null;
  }

  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn('text-sm font-normal text-destructive', className)}
      {...props}
    >
      {content}
    </div>
  );
}

export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
};

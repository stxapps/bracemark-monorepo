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
//     focus, so the VALUE can't shrink and only the label can move). Note that
//     bind is the ADD SHEET's, not every dense surface's: the extension's popup is
//     dense over 14px controls, because it pins the step back to its desktop tier
//     (input.tsx) and takes this tier for its own reason — a 14px label would tie
//     its 14px `PopupTitle`.
//
// bracemark-expo's own field labels are `text-xs text-muted-foreground` already
// (link-add-panel.tsx's Field helper), so dense is also what puts the two
// clients' add forms on the same footing.
// The labelable elements — the only ones `htmlFor` reaches on its own. HTML's
// label activation behaviour runs against the label's "labeled control", which is
// defined only for this set, and so does the accessible-name contribution: point
// `htmlFor` at anything else and clicking the label does NOTHING and the target is
// left unnamed. Nothing catches it — `jsx-a11y` checks that a label HAS a control,
// not that the control can BE one — so the symptom is a label that looks exactly
// like its neighbours and is simply dead.
//
// Which is what TagsField's trigger was: a `div role="combobox"`, a div because
// each chosen tag carries its own ✕ button and a button inside a button is invalid
// HTML (tags-field.tsx). Its own name comes from an `aria-label` there; the CLICK
// is this. ListSelect, sitting one row above it in the same forms, worked only by
// the accident of its trigger being a `Button`.
//
// So: do by hand what the browser does for the labelable set — focus the target
// and forward the click. Forwarding rather than focusing alone is what keeps those
// two picker rows behaving alike (clicking "List" opens its popover, so clicking
// "Tags" must too). A native `<select>` focuses without opening, but that ship
// sailed with the Button trigger, and adjacent rows of one form disagreeing is the
// worse outcome. A target the label already CONTAINS is skipped — the browser
// delivered that click itself.
const LABELABLE = new Set(['BUTTON', 'INPUT', 'METER', 'OUTPUT', 'PROGRESS', 'SELECT', 'TEXTAREA']);

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

//
// A label on an OPEN popup trigger closes it, the way the trigger itself does.
// The label lies outside the popup, so the press dismisses it (Radix's
// outside-pointerdown), and the click that follows then reached the trigger,
// through the browser's activation or the forwarding above, and opened it again.
// The result was a flicker that also reset the picker's search, and it caught
// people who clicked what looked like empty space to dismiss the popup. So the
// target's `aria-expanded` is read at PRESS time, before the dismissal re-renders
// it, and a press that began open ends at focus with no activation. It is
// `aria-expanded`, not a picker-specific prop, so any future popup trigger with
// a label behaves the same way.
function Label({
  className,
  density,
  onClick,
  onPointerDown,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root> & VariantProps<typeof labelVariants>) {
  const expandedAtPress = React.useRef(false);

  const onLabelPointerDown = (event: React.PointerEvent<HTMLLabelElement>) => {
    onPointerDown?.(event);
    const target = props.htmlFor === undefined ? null : document.getElementById(props.htmlFor);
    expandedAtPress.current = target?.getAttribute('aria-expanded') === 'true';
  };

  const onLabelClick = (event: React.MouseEvent<HTMLLabelElement>) => {
    const wasExpanded = expandedAtPress.current;
    expandedAtPress.current = false;
    onClick?.(event);
    if (event.defaultPrevented || props.htmlFor === undefined) return;

    const target = document.getElementById(props.htmlFor);
    if (target === null) return;
    if (event.target instanceof Node && target.contains(event.target)) return;

    if (wasExpanded) {
      // Also cancels the browser's own activation of a labelable target.
      event.preventDefault();
      target.focus();
      return;
    }
    if (LABELABLE.has(target.tagName)) return;

    target.focus();
    target.click();
  };

  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(labelVariants({ density }), className)}
      {...props}
      onPointerDown={onLabelPointerDown}
      onClick={onLabelClick}
    />
  );
}

export { Label };

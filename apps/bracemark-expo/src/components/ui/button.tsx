import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils';
import { Icon } from './icon';
import { TextClassContext } from './text';

// react-native-reusables `button` (uniwind variant), copied from the registry —
// see docs/setup.md for why the copy is manual (the CLI needs tsconfig path
// aliases; this app uses relative imports). Local changes vs upstream: imports
// rewritten to relative, plus an explicit `import * as React` (upstream leans
// on the UMD global type for `React.ComponentProps`), plus the icon-edge padding
// below, plus THE RADIUS: `rounded-4xl` on the base and none on the sizes,
// which is web-ui's shape system rather than the registry's `rounded-md`
// (docs/theme.md, _the radius scale_ — the whole kit moved together).
//
// THE PALETTE IS WEB-UI'S TOO, and it is not the registry's: `destructive` is a
// TINT (`bg-destructive/10 text-destructive`) rather than a solid fill,
// `outline` carries `bg-input/30` in both themes rather than `bg-background`
// with a dark override, `ghost` presses to `muted` rather than `accent`, and no
// variant carries a shadow — the registry puts `shadow-sm shadow-black/5` on
// every filled control and web-ui deliberately has none (docs/theme.md, _the
// two kits_). The press states are the ports of web's hover states, value for
// value, since a press is what a touch surface has instead.
//
// THE SIZE SCALE IS WEB'S SET, one touch step taller. Web's `default/xs/sm/lg`
// and `icon/icon-xs/icon-sm/icon-lg` all exist here, each at the height above
// web's (h-10 against h-9, and so on) because a phone target is not a pointer
// target — the pre-existing sizes already worked that way and the new ones
// follow them. AT EVERY WIDTH: the registry's `sm:` step down to web's height
// (`h-10 sm:h-9`, and so on through the scale) is gone, settled with the tablet
// layout together with Input's and DropdownMenu's. It answered a web question —
// past 640px the pointer is probably a mouse — and on this app 640 is a
// tablet, an unfolded foldable or a phone on its side, every one of them
// entirely touch, so the step only shrank a finger's target where the screen
// had MORE room for it (`ui/input.tsx`'s header carries the argument). A call
// site that needs a box
// the scale doesn't have restates it in `className` — `size-8` on the two dense
// row affordances, whose web twins pin the same 32 for the same reason.
//
// NO VERTICAL PADDING ON ANY SIZE, and `default` is where that had to be
// corrected: it carried the registry's `py-2`, which web-ui's own `default`
// (`h-9 gap-1.5 px-3`) does not have — so this closes a drift rather than
// opening one. On native the class could only ever do harm. Every size pins a
// height, so the padding never sizes the box; all it does is shrink the room
// the label is measured against, and Yoga measures a row child against that
// inner height AtMost, so a line box taller than it gets CLAMPED and iOS —
// which has already dropped the glyphs by half the box's surplus over Inter's
// 1.21× — loses the descender off the bottom edge. `h-10` minus `py-2` left 22
// for a label whose line box is 20 at 1× and 22.4 at the FIRST Dynamic Type
// step above default (RN's iOS multiplier for ExtraLarge is 1.118), i.e. every
// default-size button in the app clipped its g's and y's for anyone who has
// ever touched the text-size slider — and 18 under the old `sm:` step, which
// clipped at 1×. The three call sites that restated `text-base` clipped at 1× on a phone and are
// what found this (components/links/list-select.tsx carries the measurement;
// docs/theme.md, _extending_, carries the rule). Removing it is invisible at
// 1× — the height is unchanged and `items-center` centres the same line box in
// the same box — and leaves 38 inside, which absorbs the 1.3 ceiling
// (docs/accessibility.md, _font scaling_: the cap only bounds the overflow to
// what the chrome can absorb, which presumes the chrome has any to spare).
// Still drifting from web here and NOT fixed, because both are visible at 1×
// and are a design call, not a defect: web's `default` is `px-3` against this
// `px-4` (hence ListSelect's trigger restating `px-3` to sit on the Input's
// text edge) and `gap-1.5` against the base's `gap-2`.
//
// THE ICON-EDGE PADDING. The edge an icon sits against gets the smaller padding,
// so a glyph at the rim doesn't read as heavier than the text at the other end;
// icon-only buttons stay symmetric. packages/web-ui/src/components/ui/button.tsx
// is this button's web sibling and applies the SAME RULE by a different
// mechanism, on purpose — read that file's header before changing this one, and
// keep the two rules in step even though their pixel values differ (these sizes
// are tuned for touch).
//
// Web can use a CSS marker (`data-icon` + `:has()`) because its Button renders
// through Slot: with `asChild` the icon is a grandchild, and only a
// depth-agnostic selector reaches it. Here there is no Slot and no `:has()` —
// children are always direct and there is no CSS engine on native — so the
// edges are derived from the children themselves. That is strictly better than
// a marker prop: it cannot be forgotten at a call site, and it follows a
// conditional icon (`{busy && <Icon …/>}`) render by render.
//
// Replaces upstream's `has-[>svg]:px-*`, which was web-only (so it never ran in
// the shipped iOS/Android app) and shrank BOTH edges, having no way to tell
// which one held the icon. Those fragments are gone: `:has()` outranks a plain
// utility, so leaving them would have kept overriding the single-edge classes
// on web.
//
// THE BOX. `border border-transparent` on the base is load-bearing, and is the
// web sibling's rule again: RN adds borderWidth to a hug width, so without it
// `outline` — the only variant that declares `border` — came out 2px wider than
// the same label in `default`, and a footer row of [Cancel][Save] held two
// different pill widths. Reserving the edge everywhere makes the variants
// swappable. There is no `bg-clip-padding` counterpart here and there must not
// be: RN paints backgroundColor across the whole border box, so a transparent
// border keeps a filled variant full-bleed on its own.

const buttonVariants = cva(
  cn(
    'group shrink-0 flex-row items-center justify-center gap-2 rounded-4xl border border-transparent shadow-none',
    Platform.select({
      web: "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive whitespace-nowrap outline-none transition-all focus-visible:ring-[3px] disabled:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    }),
  ),
  {
    variants: {
      variant: {
        default: cn(
          'bg-primary active:bg-primary/80',
          Platform.select({ web: 'hover:bg-primary/80' }),
        ),
        destructive: cn(
          'bg-destructive/10 active:bg-destructive/20 dark:bg-destructive/20 dark:active:bg-destructive/30',
          Platform.select({
            web: 'hover:bg-destructive/20 dark:hover:bg-destructive/30 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
          }),
        ),
        outline: cn(
          'border-border bg-input/30 active:bg-input/50 dark:border-input',
          Platform.select({ web: 'hover:bg-input/50' }),
        ),
        secondary: cn(
          'bg-secondary active:bg-secondary/80',
          Platform.select({ web: 'hover:bg-secondary/80' }),
        ),
        ghost: cn(
          'active:bg-muted dark:active:bg-muted/50',
          Platform.select({ web: 'hover:bg-muted dark:hover:bg-muted/50' }),
        ),
        link: '',
      },
      size: {
        default: 'h-10 px-4',
        xs: 'h-7 gap-1 px-2.5',
        sm: 'h-9 gap-1.5 px-3',
        lg: 'h-11 px-6',
        icon: 'h-10 w-10',
        'icon-xs': 'h-7 w-7',
        'icon-sm': 'h-9 w-9',
        'icon-lg': 'h-11 w-11',
      },
      // Derived by the component from its children, never passed by a caller —
      // ButtonProps omits them for exactly that reason.
      iconStart: { true: '' },
      iconEnd: { true: '' },
    },
    // The trimmed value per size, next to the size it trims. `icon` is absent
    // on purpose: a square button has no padding to give back.
    compoundVariants: [
      { size: 'xs', iconStart: true, class: 'pl-2' },
      { size: 'xs', iconEnd: true, class: 'pr-2' },
      { size: 'default', iconStart: true, class: 'pl-3' },
      { size: 'default', iconEnd: true, class: 'pr-3' },
      { size: 'sm', iconStart: true, class: 'pl-2.5' },
      { size: 'sm', iconEnd: true, class: 'pr-2.5' },
      { size: 'lg', iconStart: true, class: 'pl-4' },
      { size: 'lg', iconEnd: true, class: 'pr-4' },
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

// Whether a child is one of this kit's icons. Deliberately an identity check
// against `Icon` rather than "anything that isn't Text": every icon in the app
// goes through that wrapper, and a looser test would misfire on a `View` used
// for layout. A raw lucide component or a spinner would not be recognised —
// extend this one predicate if that ever lands, rather than marking call sites.
function isIcon(node: React.ReactNode): boolean {
  return React.isValidElement(node) && node.type === Icon;
}

const buttonTextVariants = cva(
  cn(
    'text-foreground text-sm font-medium',
    Platform.select({ web: 'pointer-events-none transition-colors' }),
  ),
  {
    variants: {
      variant: {
        default: 'text-primary-foreground',
        destructive: 'text-destructive',
        outline: cn(
          'group-active:text-foreground',
          Platform.select({ web: 'group-hover:text-foreground' }),
        ),
        secondary: 'text-secondary-foreground',
        ghost: 'group-active:text-foreground',
        link: cn(
          'text-primary group-active:underline',
          Platform.select({ web: 'underline-offset-4 hover:underline group-hover:underline' }),
        ),
      },
      size: {
        default: '',
        xs: 'text-xs',
        sm: '',
        lg: '',
        icon: '',
        'icon-xs': '',
        'icon-sm': '',
        'icon-lg': '',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

type ButtonProps = React.ComponentProps<typeof Pressable> &
  React.RefAttributes<typeof Pressable> &
  Omit<VariantProps<typeof buttonVariants>, 'iconStart' | 'iconEnd'>;

function Button({ className, variant, size, children, ...props }: ButtonProps) {
  // `toArray` drops null/undefined, so a conditional icon collapses out of the
  // list and the padding follows it. The length guard is what keeps an
  // icon-only button symmetric at a padded size: one child is an icon with
  // nothing to be balanced against.
  // Pressable also accepts a render-prop child (it calls it with the press
  // state). Nothing to inspect there, and no button in this app uses one, so it
  // simply gets the untrimmed padding.
  const kids = typeof children === 'function' ? [] : React.Children.toArray(children);
  const labelled = kids.length > 1;
  const iconStart = labelled && isIcon(kids[0]);
  const iconEnd = labelled && isIcon(kids[kids.length - 1]);

  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <Pressable
        className={cn(
          props.disabled && 'opacity-50',
          buttonVariants({ variant, size, iconStart, iconEnd }),
          className,
        )}
        role="button"
        {...props}
      >
        {children}
      </Pressable>
    </TextClassContext.Provider>
  );
}

export { Button, buttonTextVariants, buttonVariants };
export type { ButtonProps };

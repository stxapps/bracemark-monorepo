import * as React from 'react';
import { Platform, View } from 'react-native';
import * as RadioGroupPrimitive from '@rn-primitives/radio-group';

import { cn } from '../../lib/utils';

// react-native-reusables `radio-group` (uniwind variant), copied from the
// registry — see docs/setup.md for why the copy is manual (the CLI needs
// tsconfig path aliases; this app uses relative imports). Local changes vs
// upstream: imports rewritten to relative, plus an explicit `import * as React`
// — plus the CHECKED SHAPE and the dropped control shadow, both web-ui's
// (docs/theme.md, _the two kits_): the selected disc FILLS with `bg-primary`
// under a `primary-foreground` dot, where the registry leaves the ring empty
// and paints the dot itself. The one part that does not port is noted at the
// indicator below.
// (upstream leans on the UMD global type for `React.ComponentProps`).

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root className={cn('gap-3', className)} {...props} />;
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'aspect-square size-4 shrink-0 items-center justify-center rounded-full border border-input dark:bg-input/30',
        Platform.select({
          web: 'transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        }),
        props.disabled && 'opacity-50',
        className,
      )}
      {...props}
    >
      {/* The FILL is the indicator, which the primitive mounts only when this
          item is the selected one — web reaches the same picture with
          `data-checked:bg-primary` on the item itself, which has no native
          counterpart here (@rn-primitives/radio-group keeps `checked` in a
          context it does not export, and the item is addressed by `value`).
          What does not port is the 1px ring: web's `data-checked:border-primary`
          merges the edge into the fill, and with the fill on a CHILD the
          `border-input` edge stays drawn around it.
          The fill rounds ITSELF — do not square it and lean on `overflow-hidden`
          on the item instead. Android clips children to the padding box, but iOS
          clips to the BORDER box (`enableIOSViewClipToPaddingBox` is off in RN
          0.81): a square 14pt fill cut by the 16pt circle keeps four flat sides,
          and iOS then paints the border over it. Light's opaque `--input` ring
          hides that; dark's is white/20%, so the flat sides showed straight
          through it — dark, selected, iOS only. */}
      <RadioGroupPrimitive.Indicator className="h-full w-full items-center justify-center rounded-full bg-primary">
        <View className="size-2 rounded-full bg-primary-foreground" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };

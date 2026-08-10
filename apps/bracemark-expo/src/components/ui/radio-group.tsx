import * as React from 'react';
import { Platform } from 'react-native';
import * as RadioGroupPrimitive from '@rn-primitives/radio-group';

import { cn } from '../../lib/utils';

// react-native-reusables `radio-group` (uniwind variant), copied from the
// registry — see docs/setup.md for why the copy is manual (the CLI needs
// tsconfig path aliases; this app uses relative imports). Local changes vs
// upstream: imports rewritten to relative, plus an explicit `import * as React`
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
        'aspect-square size-4 shrink-0 items-center justify-center rounded-full border border-input shadow-sm shadow-black/5 dark:bg-input/30',
        Platform.select({
          web: 'transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        }),
        props.disabled && 'opacity-50',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-primary" />
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };

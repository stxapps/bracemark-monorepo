import * as React from 'react';
import { Platform, type Role, Text as RNText } from 'react-native';
import { Slot } from '@rn-primitives/slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { MAX_FONT_SIZE_MULTIPLIER } from '../../lib/font-scale';
import { cn } from '../../lib/utils';

// react-native-reusables `text` (uniwind variant), copied from the registry —
// see docs/setup.md for why the copy is manual (the CLI needs tsconfig path
// aliases; this app uses relative imports). Local changes vs upstream:
//   • imports rewritten to relative (`@/registry/uniwind/*` isn't a real path).
//   • `font-sans` added to the base variant — RN has no CSS cascade, so this is
//     what makes Inter the app-wide default (the plan in docs/setup.md, _font_).
//   • `maxFontSizeMultiplier` defaulted — this component is one of the two
//     chokepoints where the app-wide font-scale cap lives (lib/font-scale.ts
//     carries the rationale). Set BEFORE the `{...props}` spread so a call site
//     can still opt out or choose its own ceiling.

const textVariants = cva(
  cn(
    'font-sans text-foreground text-base',
    Platform.select({
      web: 'select-text',
    }),
  ),
  {
    variants: {
      variant: {
        default: '',
        h1: cn(
          'text-center text-4xl font-extrabold tracking-tight',
          Platform.select({ web: 'scroll-m-20 text-balance' }),
        ),
        h2: cn(
          'border-border border-b pb-2 text-3xl font-semibold tracking-tight',
          Platform.select({ web: 'scroll-m-20 first:mt-0' }),
        ),
        h3: cn('text-2xl font-semibold tracking-tight', Platform.select({ web: 'scroll-m-20' })),
        h4: cn('text-xl font-semibold tracking-tight', Platform.select({ web: 'scroll-m-20' })),
        p: 'mt-3 leading-7 sm:mt-6',
        blockquote: 'mt-4 border-l-2 pl-3 italic sm:mt-6 sm:pl-6',
        code: cn(
          'bg-muted relative rounded px-[0.3rem] py-[0.2rem] font-mono text-sm font-semibold',
        ),
        lead: 'text-muted-foreground text-xl',
        large: 'text-lg font-semibold',
        small: 'text-sm font-medium leading-none',
        muted: 'text-muted-foreground text-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

type TextVariantProps = VariantProps<typeof textVariants>;

type TextVariant = NonNullable<TextVariantProps['variant']>;

const ROLE: Partial<Record<TextVariant, Role>> = {
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  blockquote: Platform.select({ web: 'blockquote' as Role }),
  code: Platform.select({ web: 'code' as Role }),
};

const ARIA_LEVEL: Partial<Record<TextVariant, string>> = {
  h1: '1',
  h2: '2',
  h3: '3',
  h4: '4',
};

const TextClassContext = React.createContext<string | undefined>(undefined);

function Text({
  className,
  asChild = false,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof RNText> &
  React.RefAttributes<typeof RNText> &
  TextVariantProps & {
    asChild?: boolean;
  }) {
  const textClass = React.useContext(TextClassContext);
  const Component = asChild ? Slot : RNText;
  return (
    <Component
      className={cn(textVariants({ variant }), textClass, className)}
      role={variant ? ROLE[variant] : undefined}
      aria-level={variant ? ARIA_LEVEL[variant] : undefined}
      maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
      {...props}
    />
  );
}

export { Text, TextClassContext };

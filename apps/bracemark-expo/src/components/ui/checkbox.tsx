import { Platform } from 'react-native';
import * as CheckboxPrimitive from '@rn-primitives/checkbox';
import { Check } from 'lucide-react-native';

import { cn } from '../../lib/utils';
import { Icon } from './icon';

// react-native-reusables `checkbox` (uniwind variant), copied from the registry —
// see docs/setup.md for why the copy is manual (the CLI needs tsconfig path
// aliases; this app uses relative imports). Local changes vs upstream: imports
// rewritten to relative, plus the box's radius — `rounded-[6px]`, matching
// web-ui rather than the registry's `rounded-[4px]` (docs/theme.md, _the
// radius scale_). The LITERAL, not `rounded-sm`: the two are the same 6px today
// (`--radius-sm` is `calc(var(--radius) - 4px)` off a 0.625rem `--radius` in
// global.css), but they couple differently — `rounded-sm` would ride `--radius`,
// and the point of that section is that the classes are the shape system while
// `--radius` moves only registry leftovers. This file said `rounded-sm` while
// this comment said `rounded-[6px]`; the class is now what the comment claims.
// The registry's `shadow-sm shadow-black/5` is dropped for the same reason as
// every other control here: web-ui carries no shadow on one.
const DEFAULT_HIT_SLOP = 24;

function Checkbox({
  className,
  checkedClassName,
  indicatorClassName,
  iconClassName,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  checkedClassName?: string;
  indicatorClassName?: string;
  iconClassName?: string;
}) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'size-4 shrink-0 rounded-[6px] border border-input dark:bg-input/30',
        Platform.select({
          web: 'peer cursor-default transition-shadow outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
          native: 'overflow-hidden',
        }),
        props.checked && cn('border-primary', checkedClassName),
        props.disabled && 'opacity-50',
        className,
      )}
      hitSlop={DEFAULT_HIT_SLOP}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className={cn('h-full w-full items-center justify-center bg-primary', indicatorClassName)}
      >
        <Icon
          as={Check}
          size={12}
          strokeWidth={Platform.OS === 'web' ? 2.5 : 3.5}
          className={cn('text-primary-foreground', iconClassName)}
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };

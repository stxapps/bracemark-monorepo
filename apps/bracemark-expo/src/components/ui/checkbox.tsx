import { Platform } from 'react-native';
import * as CheckboxPrimitive from '@rn-primitives/checkbox';
import { Check } from 'lucide-react-native';

import { cn } from '../../lib/utils';
import { Icon } from './icon';

// react-native-reusables `checkbox` (uniwind variant), copied from the registry —
// see docs/setup.md for why the copy is manual (the CLI needs tsconfig path
// aliases; this app uses relative imports). Local changes vs upstream: imports
// rewritten to relative.

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
        'size-4 shrink-0 rounded-[4px] border border-input shadow-sm shadow-black/5 dark:bg-input/30',
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

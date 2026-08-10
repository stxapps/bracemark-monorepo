import * as React from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react-native';
import { withUniwind } from 'uniwind';

import { cn } from '../../lib/utils';
import { TextClassContext } from './text';

// react-native-reusables `icon` (uniwind variant), copied from the registry —
// see docs/setup.md for why the copy is manual (the CLI needs tsconfig path
// aliases; this app uses relative imports). Local changes vs upstream: imports
// rewritten to relative, and the JSDoc example trimmed of its registry path.

type IconProps = LucideProps & {
  as: LucideIcon;
} & React.RefAttributes<LucideIcon>;

function IconImpl({ as: IconComponent, ...props }: IconProps) {
  return <IconComponent {...props} />;
}

const StyledIcon = withUniwind(IconImpl, {
  size: {
    fromClassName: 'className',
    styleProperty: 'width',
  },
  color: {
    fromClassName: 'className',
    styleProperty: 'color',
  },
});

/**
 * A wrapper component for Lucide icons with Uniwind `className` support via `withUniwind`.
 *
 * This component allows you to render any Lucide icon while applying utility classes
 * using `uniwind`. It avoids the need to wrap or configure each icon individually.
 *
 * @component
 * @example
 * ```tsx
 * import { ArrowRight } from 'lucide-react-native';
 *
 * <Icon as={ArrowRight} className="text-red-500 size-4" />
 * ```
 *
 * @param {LucideIcon} as - The Lucide icon component to render.
 * @param {string} className - Utility classes to style the icon using Uniwind.
 * @param {number} size - Icon size (overrides the size class).
 * @param {...LucideProps} ...props - Additional Lucide icon props passed to the "as" icon.
 */
function Icon({ as: IconComponent, className, ...props }: IconProps) {
  const textClass = React.useContext(TextClassContext);
  return (
    <StyledIcon
      as={IconComponent}
      className={cn('size-5 text-foreground', textClass, className)}
      {...props}
    />
  );
}

export { Icon };

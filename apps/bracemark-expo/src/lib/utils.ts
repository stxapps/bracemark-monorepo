import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// The react-native-reusables `cn` helper — byte-identical to
// packages/web-ui/src/lib/utils.ts (web-ui is platform:web and can't be
// imported here, same as the design tokens mirrored in global.css).
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

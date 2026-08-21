'use client';
import { useMemo } from 'react';

import { useWindowInsets } from './use-window-metrics';

/**
 * The gutter a floating surface keeps from the edge of the room it has, on top
 * of the safe-area insets. Radix defaults `collisionPadding` to 0, which sits a
 * flipped or shifted popover flush against the boundary; 8 is what this package
 * has always used instead. bracemark-expo's DropdownMenuContent adds the same 8
 * to its own `insets` prop, which is @rn-primitives' name for this same idea.
 */
const COLLISION_GUTTER = 8;

/** Radix's `collisionPadding` shape — one number, or per-side numbers. */
export type CollisionPadding =
  number | Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>;

/**
 * Collision padding for a Radix floating surface, defaulting to the safe-area
 * insets plus {@link COLLISION_GUTTER}.
 *
 * Floating UI clamps a flipped/shifted surface to the VIEWPORT, which under
 * `viewport-fit=cover` (bracemark-web's `layout.tsx`) extends under the notch
 * and the home indicator. So a bare number leaves every menu, select and
 * popover free to land in the unsafe band — and it does not take an unusual
 * trigger to get there, only a surface tall enough to be pushed against an
 * edge. docs/safe-area.md, _popups & dialogs_ (1) states this as the rule for
 * every Radix surface; it lives here, defaulted, rather than at each call site,
 * because the call sites are the place it was reliably forgotten.
 *
 * It bites hardest in an installed PWA — `display: standalone`
 * (bracemark-web's `manifest.json`) makes all four insets live, the top one
 * ~59px on a device with a dynamic island — and in landscape, where the side
 * inset is 44–59px in Safari either way.
 *
 * Pass `override` to opt out (`0` for flush, or per-side numbers). SSR renders
 * with zero insets and corrects on hydration, which is invisible: nothing is
 * open at that point.
 */
export function useCollisionPadding(override?: CollisionPadding): CollisionPadding {
  const insets = useWindowInsets();

  return useMemo(() => {
    if (override !== undefined) return override;
    return {
      top: insets.top + COLLISION_GUTTER,
      right: insets.right + COLLISION_GUTTER,
      bottom: insets.bottom + COLLISION_GUTTER,
      left: insets.left + COLLISION_GUTTER,
    };
  }, [override, insets.top, insets.right, insets.bottom, insets.left]);
}

import { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Portal } from '@rn-primitives/portal';

import { useAppCovered } from '../../contexts/app-cover';
import { Text } from './text';

// A hold-to-read bubble: the whole of a label the row it sits on had to
// truncate, shown while a finger holds the row and gone when it lifts — the shape
// of iOS's Large Content Viewer, which is the platform's answer to the same
// problem (a label too long, or too small, for the control carrying it). The
// owner shows it from a long-press and clears it on press-out, so there is no
// dismiss state to get stuck in. The links rail's rows are the caller
// (features/links/sidebar.tsx): one line each, never two — mixed row heights
// break the rhythm a tree is scanned by.
//
// PORTALED to the root PortalHost, not drawn in the row's own tree: the bubble
// is wider than the rail it reads from (that is the point of it), and the rail
// is a view react-native-drawer-layout owns — beside the screen when docked,
// over it as a drawer, with the stacking and the touch bounds that come with
// each. Overlays drawn inside one of those views already bit once from the
// screen's side (docs/safe-area.md, _wide windows on native_: an overlay drawn
// in the links SCREEN stops at the docked rail); the portal takes the question
// off the table. Being portaled, it answers to
// `useAppCovered` like the kit's other overlays (docs/locks.md, _overlays over a
// relock_), and has a row in overlays-under-relock.spec.tsx.
//
// HIDDEN FROM SCREEN READERS, on purpose and safely: a one-line truncated Text
// still announces its whole string, so a screen-reader user already hears what
// this shows, and a second copy would be read twice. That is also why a gesture
// is an acceptable only way in here, where it is not for bulk-edit's "Select".
//
// Placed above the row so the finger holding it doesn't cover it, and below
// when the bubble doesn't fit between the row and the top inset — failing both,
// on whichever side has more room. That takes the bubble's own HEIGHT, which
// only a layout pass knows: the title wraps as far as it needs to (that is the
// point), and a limit-length name on a phone's drawer is five lines. A fixed
// two-line allowance placed that one over the row and up under the status bar
// (Pixel 8 AVD, a row 90dp below it). So the first frame lays the bubble out
// invisibly, `onLayout` reports its height, and the next places it. The height
// is kept per label and width, so holding the same row again skips that frame.
// Starts at the row's left edge and may run across the list to the window's
// right inset. Coordinates are the row's `measure` PAGE offsets, relative to the
// root view — the box the PortalHost fills — Split View and freeform windows
// included. NOT `measureInWindow`: on Android that measures from below the
// status bar while the portal places from the root view's top, so the bubble
// stood one status bar (24dp on the tablet AVD) above its row; iOS agrees on
// both, which is why the iPad looked right. @rn-primitives anchors its dropdowns
// off the same page offsets.

export type PeekAnchor = { x: number; y: number; width: number; height: number };

const GAP = 4;
const EDGE = 8;

export function Peek({
  anchor,
  title,
  detail,
}: {
  // The held row's box in window coordinates, or null when nothing is held.
  anchor: PeekAnchor | null;
  title: string;
  // A muted second line — the rail puts a nested row's path there.
  detail?: string;
}) {
  const covered = useAppCovered();
  const frame = useSafeAreaFrame();
  const insets = useSafeAreaInsets();
  const [measured, setMeasured] = useState<{ key: string; height: number } | null>(null);
  if (!anchor || covered) return null;

  const left = Math.max(anchor.x, insets.left + EDGE);
  const maxWidth = Math.max(0, frame.width - left - insets.right - EDGE);
  // Everything the height depends on. Also the View's key, so a new label
  // remounts it and `onLayout` fires even when its size happens not to change.
  const key = `${maxWidth}\n${title}\n${detail ?? ''}`;
  const height = measured?.key === key ? measured.height : null;

  const roomAbove = anchor.y - GAP - insets.top - EDGE;
  const roomBelow = frame.height - insets.bottom - EDGE - (anchor.y + anchor.height + GAP);
  const above =
    height === null || height <= roomAbove || (height > roomBelow && roomAbove >= roomBelow);
  const vertical = above
    ? { bottom: frame.height - anchor.y + GAP }
    : { top: anchor.y + anchor.height + GAP };

  return (
    <Portal name="peek">
      <View
        key={key}
        onLayout={(e) => setMeasured({ key, height: e.nativeEvent.layout.height })}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          position: 'absolute',
          left,
          maxWidth,
          pointerEvents: 'none',
          opacity: height === null ? 0 : 1,
          ...vertical,
        }}
        className="rounded-lg border border-border bg-popover px-3 py-2 shadow-lg shadow-black/5"
      >
        <Text className="text-sm text-popover-foreground">{title}</Text>
        {detail ? <Text className="text-xs text-muted-foreground">{detail}</Text> : null}
      </View>
    </Portal>
  );
}

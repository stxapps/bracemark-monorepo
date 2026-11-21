// The scroller both share-sheet pickers put their rows in — the app's PickerScroller
// (components/links/picker-scroller.tsx, a FlatList: the window, the keyboard props
// and the touch claim are its), with the share sheet's own bounds.
//
// ⚠ IT IS VIRTUALIZED FOR MEMORY, NOT SPEED. In the iOS share extension every
// mounted row is memory under a hard 120 MB per-process cap, and nothing bounds
// how many lists or tags an account holds (docs/data-limits.md, _counts: none
// per kind_). With every row mounted in a ScrollView, an account of 300 lists
// took the list picker from ~60 MB to 118 MB while it was scrolled and filtered,
// and with a read-mode copy at its cap the kernel killed the share extension in
// it, twice (docs/share-sheet.md, _300 lists and 300 tags, and a copy at the
// cap_). Nothing fails if this goes back to `rows.map` inside a ScrollView: the
// specs pass, the simulator has no cap, and the sheet vanishes on a phone.
//
// What is the share sheet's own:
//
//   - The bounds. `max-h-72` (288pt, ~6 rows) rather than `flex-1`, since neither
//     host gives the panel a height to fill — both grow it to content (Android
//     caps at 85%) — and a max-height behaves correctly in both. `min-h-0 shrink`
//     is the LAST link of the sheet's squeeze chain (share-kit.tsx's header): the
//     scroller is the only child of either picker that may lose height, so when
//     the keyboard takes the room this is what gives it up, and the header, the
//     field and Done stay put. Miss it and the panel overflows the frame instead —
//     nothing clips, it just paints outside its own background.
//   - Why `keyboardDismissMode` is `interactive` here, beyond PickerScroller's reason:
//     the panel is parked on the keyboard, so `on-drag` dropped the keyboard at
//     the start of a scroll and the whole sheet fell a keyboard's height out from
//     under the finger. The pickers' inputs are `submitBehavior="submit"`, so
//     return never blurs them either: the way out is the tap layer in ShareSheet,
//     whose header carries the whole argument.
//
// A PULL DOWN FROM THE TOP OF THIS LIST IS NOT OURS on iOS: the share extension
// sits in a system sheet, and with the list at its top the pull goes to that
// sheet's swipe-to-dismiss. A short one tucks the keyboard away and brings it
// back, the field never having blurred — so don't count on "drag down into the
// keys" as a keyboard exit here. A long one used to close the sheet and the
// unsaved share with it; `holdSwipe` on the pickers' ShareSheet is what holds
// that off (share-kit.tsx, docs/share-sheet.md).

import type { ReactElement } from 'react';
import type { ListRenderItem } from 'react-native';

import { PickerScroller } from '../../components/links/picker-scroller';

export function SharePickerScroller<T>(props: {
  data: readonly T[];
  renderItem: ListRenderItem<T>;
  keyExtractor: (item: T) => string;
  extraData?: unknown;
  emptyText?: string;
  footer?: ReactElement | null;
  scrollResetKey?: string;
}) {
  return <PickerScroller {...props} className="max-h-72 min-h-0 shrink" />;
}

// The scroller both share-sheet pickers put their rows in — a FlatList, so only
// the rows on screen (and a few screens either side) are mounted.
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
// The window: the box is `max-h-72` (288pt), ~6 rows of 44pt. 12 rows mount
// first, 12 per batch after, and `windowSize` 5 keeps two viewports either side —
// ~30 rows mounted whatever the library holds.
//
// Everything else is what the ScrollView it replaced had, for the same reasons:
//
//   - BOUNDED rather than `flex-1`, since neither host gives the panel a height
//     to fill — both grow it to content (Android caps at 85%) — and a max-height
//     behaves correctly in both. `min-h-0 shrink` is the LAST link of the sheet's
//     squeeze chain (share-kit.tsx's header): the scroller is the only child of
//     either picker that may lose height, so when the keyboard takes the room
//     this is what gives it up, and the header, the field and Done stay put.
//     Miss it and the panel overflows the frame instead — nothing clips, it just
//     paints outside its own background.
//   - `keyboardDismissMode="interactive"`, not the app's usual `on-drag`, for
//     list-command.tsx's reason and a bigger jump than the one there: the panel
//     is parked on the keyboard, so `on-drag` dropped the keyboard at the start
//     of a scroll and the whole sheet fell a keyboard's height out from under
//     the finger while this list regrew. A scroll now keeps the keyboard
//     (Android maps the value to `none`). The pickers' inputs are
//     `submitBehavior="submit"`, so return never blurs them either: the way out
//     is the tap layer in ShareSheet, whose header carries the whole argument.
//     `"handled"` beside it keeps a row tap a row tap: without it the default
//     `"never"` would swallow the first press on the very row you filtered for.
//   - The empty text sits in a ScrollClaim: ShareSheet's frame around this claims
//     touches, so a drag from plain text would not scroll on iOS
//     (components/ui/scroll-claim.tsx). The rows and the Create row are
//     Pressables, which claim from below the scroller on their own.
//
// A PULL DOWN FROM THE TOP OF THIS LIST IS NOT OURS on iOS: the share extension
// sits in a system sheet, and with the list at its top the pull goes to that
// sheet's swipe-to-dismiss. A short one tucks the keyboard away and brings it
// back, the field never having blurred — so don't count on "drag down into the
// keys" as a keyboard exit here. A long one used to close the sheet and the
// unsaved share with it; `holdSwipe` on the pickers' ShareSheet is what holds
// that off (share-kit.tsx, docs/share-sheet.md).

import type { ReactElement } from 'react';
import { FlatList, type ListRenderItem } from 'react-native';

import { ScrollClaim } from '../../components/ui/scroll-claim';
import { Text } from '../../components/ui/text';

export function SharePickerList<T>({
  data,
  renderItem,
  keyExtractor,
  extraData,
  emptyText,
  footer,
}: {
  data: readonly T[];
  renderItem: ListRenderItem<T>;
  keyExtractor: (item: T) => string;
  // What the rows read besides `data` — the selection — so a change re-renders
  // the mounted ones.
  extraData?: unknown;
  // Shown when `data` is empty; leave it undefined where a Create row stands in.
  emptyText?: string;
  // The Create row, beneath the results.
  footer?: ReactElement | null;
}) {
  return (
    <FlatList
      className="max-h-72 min-h-0 shrink"
      data={data}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      extraData={extraData}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      windowSize={5}
      ListEmptyComponent={
        emptyText === undefined ? null : (
          <ScrollClaim>
            <Text className="py-6 text-center text-sm text-muted-foreground">{emptyText}</Text>
          </ScrollClaim>
        )
      }
      ListFooterComponent={footer ?? null}
    />
  );
}

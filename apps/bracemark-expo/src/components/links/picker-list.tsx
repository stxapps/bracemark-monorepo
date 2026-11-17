// The scroller every list and tag picker puts its rows in — the in-app Move to,
// list-select and tag dialogs (list-command.tsx, tags-command.tsx) and the share
// sheet's two pickers (features/share/share-picker-list.tsx). A FlatList, so the
// rows on screen and a few screens either side are mounted, not the library.
//
// Why: nothing bounds how many lists or tags an account holds — the limits bound
// depth, not count (docs/data-limits.md, _counts: none per kind_) — and a picker
// that mounts every row pays per row on every open. In the app that is a stall
// when the dialog opens; in the iOS share extension it is memory under a hard
// cap, where 300 lists in a ScrollView got the process killed (docs/share-sheet.md,
// _300 lists and 300 tags, and a copy at the cap_). The render leg's `dialogs`
// window reads the in-app cost (docs/client-queries.md, _the tree surfaces mount
// every row_).
//
// The window: 12 rows mount first and 12 a batch after; `windowSize` 5 keeps two
// viewports either side. A picker's box is 288–320pt, ~6–7 rows of 44pt, so
// ~30 rows are mounted whatever the library holds — and a small library, under a
// screenful, mounts every row in the first commit exactly as a ScrollView did.
//
// What each host's ScrollView had, kept: the keyboard pair and the touch claim.
//
//   - `keyboardShouldPersistTaps="handled"`, so a row tap made with the keyboard
//     up is a row tap: the default `"never"` would swallow the first press on the
//     very row you filtered for.
//   - `keyboardDismissMode="interactive"`, not the app's usual `on-drag`: every
//     host is a centred Dialog or the share sheet's panel parked on the keyboard,
//     and dropping the keyboard mid-drag re-centres the host and regrows this
//     list under the finger (list-command.tsx's history). Android maps it to
//     `none`.
//   - The empty text sits in a ScrollClaim: the dialog or sheet around this claims
//     touches, so a drag from plain text would not scroll on iOS
//     (components/ui/scroll-claim.tsx). Rows and Create rows are Pressables, which
//     claim from below the scroller on their own.
//
// Each host passes its own bounds as `className` — `max-h-80 shrink` in a dialog
// (bounded by what the keyboard leaves), `max-h-72 min-h-0 shrink` in the share
// sheet (the last link of its squeeze chain) — and those comments stay with them.

import type { ReactElement } from 'react';
import { FlatList, type ListRenderItem } from 'react-native';

import { ScrollClaim } from '../ui/scroll-claim';
import { Text } from '../ui/text';

export function PickerList<T>({
  data,
  renderItem,
  keyExtractor,
  extraData,
  emptyText,
  header,
  footer,
  className,
  testID,
  nestedScrollEnabled,
}: {
  data: readonly T[];
  renderItem: ListRenderItem<T>;
  keyExtractor: (item: T) => string;
  // What the rows read besides `data` — the selection — so a change re-renders
  // the mounted ones.
  extraData?: unknown;
  // Shown when `data` is empty; leave it undefined where a Create row stands in.
  emptyText?: string;
  // Above the rows (list-command's "Top level") and beneath them (a Create row).
  header?: ReactElement | null;
  footer?: ReactElement | null;
  className: string;
  testID?: string;
  nestedScrollEnabled?: boolean;
}) {
  return (
    <FlatList
      testID={testID}
      className={className}
      data={data}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      extraData={extraData}
      nestedScrollEnabled={nestedScrollEnabled}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      windowSize={5}
      ListHeaderComponent={header ?? null}
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

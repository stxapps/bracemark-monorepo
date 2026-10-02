import { type ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from './ui/text';

// Sits a fixed-size glyph — a radio mark, a checkbox, a leading icon — on the
// FIRST line of the Text beside it, in a row that is `items-start`. The settings
// radio rows (misc-, extraction- and data-section) use it twice each: once around
// the radio, once around the icon, so the two share a line with the label however
// far the label wraps. The confirm-checkbox rows (auth's show-once-secret, the two
// delete confirmations in settings) use it once, around the box, and so does
// every notice, banner and receipt line that leads with an icon — ErrorText and
// SettingsNotice among them, which is how most call sites reach it.
//
// It is the ONLY way this app puts a glyph beside wrapping text. A new row that
// reaches for `mt-0.5` is the web twin's class arriving in a port: correct there,
// where the margin is rem and scales with the label, and here correct at 1× at
// best.
//
// The glyph is 16 and does not scale; the line beside it moves with the OS text
// size. So every way of writing the offset as a NUMBER is right at one size only.
// A margin was the first attempt — `mt-0.5`, carried over from web, where it is
// exact: the label there is `text-sm`, a 20 line, and all of it rem. The radio
// rows sit beside `text-base`, a 24 line, so the radio rode 2 above its own label
// at 1× and further at every step up. The checkbox rows kept `text-sm`, so there
// the margin IS right at 1× — and is 3 short at the 1.3 cap, where the line is 26
// and the box needs 5: it only looked ported correctly. `lineHeight ×
// useCappedFontScale()` is the second attempt, and it is wrong twice: that hook
// floors at 1 where the text does not, and it is linear where Android is not
// (PixelUtil.toPixelFromSP goes through `TypedValue.applyDimension`, which from
// Android 14 scales a large sp by less than the font scale). And `items-center`
// on the row needs no number but holds only until the label wraps, when it
// centres on the whole block.
//
// So nothing is computed. The zero-width Text is a STRUT: it lays out one empty
// line at whatever height this device gives that text size today, the slot takes
// that height, and `items-center` centres the glyph in it.
//
// What it centres ON is the line box, which for Inter is the CAP-height centre
// (ascender − cap height = descender, docs/theme.md, _extending_). A sentence-case
// label carries its weight lower than that — the x-height centre sits 0.09em
// under it, 1.3 at `text-sm` — so a hard-edged box can read a hair high beside
// lowercase. That is the same place web puts it at 1×, and it is left alone: the
// honest correction depends on the letters in the label, not on the glyph.
//
// `textClassName` is the size class of the Text BESIDE the slot, and it has to be
// said because the strut cannot see its neighbour. It defaults to `text-base`
// only because that is Text's own default. A size that disagrees with the label
// fails quietly — the glyph centres, exactly, on a line that is not the one next
// to it — so a label that changes size takes this prop with it.
//
// `aria-hidden` rides a View because RN's Text ignores the prop
// (initial-sync-gate.tsx carries the measurement).
export function FirstLineSlot({
  textClassName,
  children,
}: {
  textClassName?: string;
  children: ReactNode;
}) {
  return (
    <View className="shrink-0 flex-row items-center">
      {children}
      <View aria-hidden className="w-0">
        <Text className={textClassName}>{'​'}</Text>
      </View>
    </View>
  );
}

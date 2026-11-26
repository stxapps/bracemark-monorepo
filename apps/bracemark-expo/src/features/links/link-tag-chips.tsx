import { createContext, useContext, useState } from 'react';
import { Pressable, View } from 'react-native';

import { type LinkView } from '@stxapps/expo-react';
import { fitChips } from '@stxapps/shared';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Text } from '../../components/ui/text';
import { useCappedFontScale } from '../../lib/font-scale';
import { EXPO_TAG_LINES_SUPPORTED } from '../../lib/tag-lines';
import { useLinksPage } from './page-provider';
import { useEngagedOpen } from './shared';

// 24pt tall exactly: py-1 (4+4) around the 16pt line box `leading-4` pins on the
// chip's Text. The label is `text-foreground/80`, not `text-muted-foreground`:
// that token is calibrated against the screen background, and on the chip's own
// fill it drops to 4.4:1 and below in light mode as the item moves under it —
// under the 4.5:1 AA floor at 12pt.
// Web's chip carries the same numbers (its own TAG_CHIP_CLASS), and there the 24
// is load-bearing for a fixed row budget; here FlashList measures, so keeping
// them equal is about the two apps looking alike, not about layout.
//
// `max-w-32` is web's cap too, but it does more work here, because these chips
// are `shrink` where web's are `shrink-0` (it measures which ones fit instead).
// Two things compound without it: Yoga implements no `min-width: auto`
// min-content floor, so a chip shrinks straight past its text down to its
// padding; and shrink is proportional to the flex BASE while `px-2` is not
// shrinkable, so a 300pt tag beside two short ones drags the short ones' labels
// down to an ellipsis with it (equal percentage lost, far more of it text). The
// cap bounds one long name's pull on its neighbours.
//
// The fill is an alpha toward the FOREGROUND, not one of the wash tokens, and it
// is web's string verbatim (`_layouts/shared/link-tag-chips.tsx`, which carries
// the arithmetic) with `active:` standing in for its `hover:`. The short of it:
// a chip sits on an item, an item has three surfaces — plain, pressed
// `active:bg-muted/50`, and `bg-muted` while selected — and `--muted` /
// `--secondary` / `--accent` are one grey in this palette, so a `bg-muted` pill
// stepped 28/255 off a plain dark item, 14 off a pressed one and 0 off a
// selected one: the strip gone outright while the user picks links by hand.
// Alpha toward the foreground can't collapse on any of them (every item surface
// in both themes sits on the foreground's opposite side), and — unlike the
// opaque mix web could otherwise have promoted — it needs no new `--color-*`
// token: there is no `color-mix` on this side, and a token here would owe an
// entry in `tools/prettier/expo-tailwind.css` as well. `active:` doubles the alpha for a
// step the size of the base one, and stays in the base string: a selected chip
// is inert (bulk-edit renders plain Views), so it never presses.
const TAG_CHIP_CLASS = 'max-w-32 rounded-full bg-foreground/6 px-2 py-1 active:bg-foreground/12';

// The visual chip is 24pt tall. Ten points above and below bring its vertical
// target to the iOS 44pt floor without stealing any of a neighbouring chip's
// visible width. Horizontal slop would overlap at this strip's 4pt gap, so it
// deliberately stays zero; see docs/accessibility.md.
const TAG_CHIP_HIT_SLOP = { top: 10, bottom: 10 } as const;

// The strip ESTIMATES which chips fit, where web measures every chip with a hidden
// clone + ResizeObserver (`_layouts/shared/link-tag-chips.tsx`). RN has no
// synchronous pre-paint measure, so measuring each native chip would land a frame
// late in recycled cells. The arithmetic is shared (@stxapps/shared `fitChips`,
// which web's row estimates use too): it packs the chips into at most `maxLines`
// lines (the `tagLines` option) and this draws each line as its OWN single-line
// row. A chip the estimate got wrong then truncates (they're `shrink` with one
// line of text) instead of wrapping onto a line nothing planned for — so the
// strip's height is exactly the fit's, and never changes after it's drawn unless
// its width does.
//
// THE WIDTH AT FIRST RENDER is the whole game (docs/link-layouts.md, _heights_).
// A one-line strip is one line tall whatever the width, so learning it late —
// in `onLayout`, after FlashList measured the cell — only changes which chips
// show. A strip of 2–3 lines is as tall as its width allows, so a width learned
// late would grow the cell after FlashList measured it, and the list jumps. So a
// strip renders from the first width it can get, in order:
//   - its own `onLayout` width, once it has one (and a RECYCLED cell keeps it:
//     FlashList reuses the component, and every strip in a list is the same width);
//   - the list's shared width (TagStripWidth, below) — the first strip to lay out
//     stores it, so every strip mounted after it lays out right the first time.
//     For the LIST layout main.tsx starts the box at an estimate (the pane less
//     the row's chrome), because a row only hears of a bucketed width
//     (link-row.tsx says why) and its first screenful would otherwise render
//     before any strip had measured;
//   - `seedWidth` from the item — the card knows its own width exactly
//     (main.tsx hands it over for the banner), so its strip starts right even on
//     the first screenful.
// With none of them (0), the fit keeps one named chip plus "+N" on ONE line.
//
// Measured with a temporary probe on the iPhone 17 Pro and iPad (A16)
// simulators, `plus-worst`, tag lines 3: no strip changed its line count after
// its first render — fast scrolling both ways in both layouts, and a cold launch.
// Before the list's estimate, 2 of the first 4 rows did at a cold launch.
//
// MAX_CHIPS — five per line — rides in the shared metrics (`maxPerLine`): at the
// wide end (a tablet row) a line has room for a dozen, and past about five tags
// compete with the title they annotate.

// The list's tag-strip width, shared by every strip in it — a plain mutable box,
// not state: a strip READS it at render and WRITES it from its own `onLayout`, and
// nothing re-renders because it moved (each strip that cares has its own
// `onLayout`). main.tsx makes a fresh one whenever the width could have changed.
export const TagStripWidth = createContext<{ current: number }>({ current: 0 });

// The item's tag-chip strip — web's LinkTagChips (`_layouts/shared/
// link-tag-chips.tsx`), with the estimated fit above standing in for its
// measured one: one pressable chip per tag, in the link's own `tagIds` order,
// each navigating to that tag's view via setSimpleQuery — the same canonical
// `/links?tag=…` URL the drawer writes. Ids the map doesn't know (a tag deleted
// / not yet synced) are skipped; no tags renders nothing, so callers can place
// it unconditionally.
//
// The chips sit INSIDE the item's Pressable — fine on this platform: RN's
// responder hands the touch to the innermost pressable, so a chip press never
// also fires the item (web needed the chips outside the row's <a> instead).
// "+N" opens the overflow tags as a dropdown (the popover stand-in — same
// portaled content, same engagement reporting via useEngagedOpen).
//
// In bulk-edit mode the whole strip goes INERT — plain Views, no press, no menu
// — and the item's own Pressable takes the touch, since a non-pressable child
// never claims the responder. Web makes the same strip inert for the same
// reason (`_layouts/shared/link-tag-chips.tsx`), but it had to, and this doesn't:
// there, the item's click sits on an ancestor, so a chip that toggled as well
// toggled TWICE and the selection never moved, and the dead gaps between pills
// were dead for real. Here the responder rule already covered the gaps and
// already stopped the double fire, so this is only the strip declining to
// duplicate the item's own press — one behaviour, in one place, spelled the same
// way on both platforms. What it changes on a device is press FEEDBACK: pressing
// a chip while selecting now lights the whole item (`active:bg-muted/50`), which
// is what is actually about to happen.
export function LinkTagChips({
  link,
  tagsById,
  selectMode,
  maxLines = 1,
  seedWidth = 0,
  className = '',
}: {
  link: LinkView;
  tagsById: Map<string, string>;
  // Bulk-edit mode, handed down by the item (its LinkItemProps.selectMode) rather
  // than read off useLinksViewState: that value changes whenever any menu opens,
  // and a subscription here would re-render the strip in every mounted item.
  selectMode: boolean;
  // The `tagLines` option. Ignored (one line) while EXPO_TAG_LINES_SUPPORTED is off.
  maxLines?: number;
  // The strip's width as the item knows it, for its first render (above).
  seedWidth?: number;
  className?: string;
}) {
  const { setSimpleQuery } = useLinksPage();
  const [, onOverflowOpenChange] = useEngagedOpen();
  const shared = useContext(TagStripWidth);
  const [ownWidth, setOwnWidth] = useState(0);
  // The chip's own text obeys the app-wide ceiling (components/ui/text.tsx), so
  // the fit has to reason at the capped scale, not the raw one. The helper's
  // floor at 1 is conservative here rather than exact — a user on SMALLER
  // system text gets chips sized as if at 1.0, which can only cost a chip.
  const fontScale = useCappedFontScale();

  const chips = link.tagIds
    .map((id) => ({ id, name: tagsById.get(id) }))
    .filter((c): c is { id: string; name: string } => c.name !== undefined);
  if (chips.length === 0) return null;

  const width = ownWidth || shared.current || seedWidth;
  const fit = fitChips(
    chips.map((c) => c.name),
    width,
    EXPO_TAG_LINES_SUPPORTED ? maxLines : 1,
    fontScale,
  );
  const lines: (typeof chips)[] = [];
  let next = 0;
  for (const count of fit.lines) {
    lines.push(chips.slice(next, next + count));
    next += count;
  }
  const overflow = chips.slice(next);

  const onTagPress = (id: string) => setSimpleQuery({ kind: 'tag', id });

  const chip = (c: { id: string; name: string }) =>
    selectMode ? (
      <View key={c.id} className={`shrink ${TAG_CHIP_CLASS}`}>
        <Text numberOfLines={1} className="text-xs leading-4 text-foreground/80">
          {c.name}
        </Text>
      </View>
    ) : (
      <Pressable
        role="button"
        key={c.id}
        onPress={() => onTagPress(c.id)}
        hitSlop={TAG_CHIP_HIT_SLOP}
        className={`shrink ${TAG_CHIP_CLASS}`}
      >
        <Text numberOfLines={1} className="text-xs leading-4 text-foreground/80">
          {c.name}
        </Text>
      </Pressable>
    );

  const more =
    overflow.length > 0 &&
    (selectMode ? (
      <View className={`shrink-0 ${TAG_CHIP_CLASS}`}>
        <Text className="text-xs leading-4 text-foreground/80">+{overflow.length}</Text>
      </View>
    ) : (
      <DropdownMenu onOpenChange={onOverflowOpenChange}>
        <DropdownMenuTrigger asChild>
          <Pressable
            role="button"
            aria-label={`Show ${overflow.length} more ${overflow.length === 1 ? 'tag' : 'tags'}`}
            hitSlop={TAG_CHIP_HIT_SLOP}
            className={`shrink-0 ${TAG_CHIP_CLASS}`}
          >
            <Text className="text-xs leading-4 text-foreground/80">+{overflow.length}</Text>
          </Pressable>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-64">
          {overflow.map((c) => (
            <DropdownMenuItem key={c.id} onPress={() => onTagPress(c.id)}>
              <Text numberOfLines={1}>{c.name}</Text>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ));

  return (
    <View className={className}>
      <View
        // gap-1 between lines, the same 4 as between chips (TAG_CHIP_METRICS.gap).
        className="gap-1"
        onLayout={(event) => {
          const measured = event.nativeEvent.layout.width;
          shared.current = measured;
          setOwnWidth((current) => (current === measured ? current : measured));
        }}
      >
        {lines.map((line, index) => (
          <View key={index} className="flex-row items-center gap-1 overflow-hidden">
            {line.map(chip)}
            {index === lines.length - 1 && more}
          </View>
        ))}
      </View>
    </View>
  );
}

import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { type LinkView } from '@stxapps/expo-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Text } from '../../components/ui/text';
import { useCappedFontScale } from '../../lib/font-scale';
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

// The strip measures ITS OWN container width, then ESTIMATES which chips fit,
// where web measures every chip with a hidden clone + ResizeObserver
// (`_layouts/shared/link-tag-chips.tsx`). Owning the container measurement here
// removes the error-prone chrome subtraction that used to be split between the
// card and row renderers. Measuring each native chip is a different trade: RN
// has no synchronous pre-paint measure, so all those `onLayout`s would land a
// frame late in recycled cells and need a per-label cache to avoid repeated
// visible reshuffles.
//
// Before the one container layout arrives, `fitChipCount` conservatively keeps
// one named tag plus `+N`. The strip is therefore never blank or loading and its
// fixed one-line height never changes; layout only expands it when there is
// proven room. The numbers below still estimate label widths, rounded AGAINST
// fitting: overestimate a chip and the strip shows one fewer than it could;
// underestimate and the chips are already `shrink` with `numberOfLines={1}`, so
// the overflow lands as truncation, never as a clipped or occluded row.
const CHIP_PADDING = 16; // px-2, both sides — dp, so it does NOT font-scale
const CHIP_GAP = 4; // the strip's gap-1
const CHIP_MAX_WIDTH = 128; // max-w-32, the cap a long label can reach
const CHAR_WIDTH = 6.6; // average advance at text-xs/12pt, rounded up from ~6.2
const MORE_CHIP_WIDTH = 38; // the "+N" chip at a realistic widest N ("+12")

// A ceiling on top of the width fit, for the wide end (a tablet list row has
// room for a dozen). Tags are metadata; past about five the strip starts
// competing with the title it annotates, which is the thing the item is
// actually for. Web has no such cap because its rows are budgeted in LINES,
// which bounds the count on its own.
const MAX_CHIPS = 5;

// How many chips fit `width`, mirroring web's two passes: take chips while they
// fit, then — only if any are left over — give back trailing chips until the
// "+N" chip fits after the ones kept.
//
// Floors at one kept chip, where web can fall to zero. Web's card row has a
// second line to move a long chip onto; this strip is one line, so falling to
// zero would paint a bare "+3" beside a link that has three perfectly nameable
// tags. One shrunk-and-ellipsized chip carries more than that, and `shrink`
// makes it fit whatever is left over.
function fitChipCount(names: string[], width: number, fontScale: number): number {
  const widthOf = (name: string) =>
    Math.min(CHIP_PADDING + name.length * CHAR_WIDTH * fontScale, CHIP_MAX_WIDTH);

  let used = 0;
  let kept = 0;
  while (kept < names.length && kept < MAX_CHIPS) {
    const cost = (kept === 0 ? 0 : CHIP_GAP) + widthOf(names[kept]);
    if (used + cost > width) break;
    used += cost;
    kept += 1;
  }
  while (kept > 1 && kept < names.length && used + CHIP_GAP + MORE_CHIP_WIDTH > width) {
    kept -= 1;
    used -= widthOf(names[kept]) + (kept === 0 ? 0 : CHIP_GAP);
  }
  return Math.max(kept, 1);
}

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
  className = '',
}: {
  link: LinkView;
  tagsById: Map<string, string>;
  // Bulk-edit mode, handed down by the item (its LinkItemProps.selectMode) rather
  // than read off useLinksViewState: that value changes whenever any menu opens,
  // and a subscription here would re-render the strip in every mounted item.
  selectMode: boolean;
  className?: string;
}) {
  const { setSimpleQuery } = useLinksPage();
  const [, onOverflowOpenChange] = useEngagedOpen();
  const [availableWidth, setAvailableWidth] = useState(0);
  // The chip's own text obeys the app-wide ceiling (components/ui/text.tsx), so
  // the fit has to reason at the capped scale, not the raw one. The helper's
  // floor at 1 is conservative here rather than exact — a user on SMALLER
  // system text gets chips sized as if at 1.0, which can only cost a chip.
  const fontScale = useCappedFontScale();

  const chips = link.tagIds
    .map((id) => ({ id, name: tagsById.get(id) }))
    .filter((c): c is { id: string; name: string } => c.name !== undefined);
  if (chips.length === 0) return null;

  const visibleCount = fitChipCount(
    chips.map((c) => c.name),
    availableWidth,
    fontScale,
  );
  const overflow = chips.slice(visibleCount);

  const onTagPress = (id: string) => setSimpleQuery({ kind: 'tag', id });

  return (
    <View className={className}>
      <View
        className="flex-row items-center gap-1 overflow-hidden"
        onLayout={(event) => {
          const width = event.nativeEvent.layout.width;
          setAvailableWidth((current) => (current === width ? current : width));
        }}
      >
        {chips.slice(0, visibleCount).map((chip) =>
          selectMode ? (
            <View key={chip.id} className={`shrink ${TAG_CHIP_CLASS}`}>
              <Text numberOfLines={1} className="text-xs leading-4 text-foreground/80">
                {chip.name}
              </Text>
            </View>
          ) : (
            <Pressable
              role="button"
              key={chip.id}
              onPress={() => onTagPress(chip.id)}
              hitSlop={TAG_CHIP_HIT_SLOP}
              className={`shrink ${TAG_CHIP_CLASS}`}
            >
              <Text numberOfLines={1} className="text-xs leading-4 text-foreground/80">
                {chip.name}
              </Text>
            </Pressable>
          ),
        )}
        {overflow.length > 0 &&
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
                {overflow.map((chip) => (
                  <DropdownMenuItem key={chip.id} onPress={() => onTagPress(chip.id)}>
                    <Text numberOfLines={1}>{chip.name}</Text>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ))}
      </View>
    </View>
  );
}

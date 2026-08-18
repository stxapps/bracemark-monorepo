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
import { useLinksViewState } from './view-state-provider';

// 24pt tall exactly: py-1 (4+4) around the 16pt line box `leading-4` pins on the
// chip's Text. The label is `text-foreground/70`, not `text-muted-foreground`:
// that token is calibrated against the screen background, and on the chip's own
// fill it drops to 4.35:1 in light mode — under the 4.5:1 AA floor at 12pt.
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
const TAG_CHIP_CLASS = 'bg-muted active:bg-muted/70 max-w-32 rounded-full px-2 py-1';

// The strip ESTIMATES which chips fit its width, where web MEASURES (a hidden
// clone + a ResizeObserver, `_layouts/shared/link-tag-chips.tsx`). Measuring is
// the better answer and it isn't available here: RN has no synchronous
// pre-paint measure, so the equivalent is an `onLayout` that lands a frame
// LATE — once per item, re-running on every recycled cell bind, inside a
// virtualized list that is usually mid-scroll when it happens. A visible chip
// pop on every row is a worse artifact than a chip too few.
//
// So the caller passes the width it can give the strip (link-row.tsx and
// link-card.tsx each subtract their own chrome from the item width main.tsx
// hands down) and the numbers below turn names into widths. Being an estimate
// is safe in one direction only, so every constant here is rounded AGAINST
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
// `/links?tag=…` URL the drawer writes. In bulk-edit mode a chip toggles the
// item's selection instead, matching the item press. Ids the map doesn't know
// (a tag deleted / not yet synced) are skipped; no tags renders nothing, so
// callers can place it unconditionally.
//
// The chips sit INSIDE the item's Pressable — fine on this platform: RN's
// responder hands the touch to the innermost pressable, so a chip press never
// also fires the item (web needed the chips outside the row's <a> instead).
// "+N" opens the overflow tags as a dropdown (the popover stand-in — same
// portaled content, same engagement reporting via useEngagedOpen); in bulk-edit
// mode it toggles selection like every other chip (no menu), web verbatim.
export function LinkTagChips({
  link,
  tagsById,
  availableWidth,
  className = '',
}: {
  link: LinkView;
  tagsById: Map<string, string>;
  // What the item can spare for the strip, in pt. The item computes it, since
  // only the item knows its own chrome.
  availableWidth: number;
  className?: string;
}) {
  const { setSimpleQuery } = useLinksPage();
  const { bulkEditing, toggleSelected } = useLinksViewState();
  const [, onOverflowOpenChange] = useEngagedOpen();
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

  const onTagPress = (id: string) =>
    bulkEditing ? toggleSelected(link) : setSimpleQuery({ kind: 'tag', id });

  return (
    <View className={`flex-row items-center gap-1 overflow-hidden ${className}`}>
      {chips.slice(0, visibleCount).map((chip) => (
        <Pressable
          role="button"
          key={chip.id}
          onPress={() => onTagPress(chip.id)}
          className={`shrink ${TAG_CHIP_CLASS}`}
        >
          <Text numberOfLines={1} className="text-xs leading-4 text-foreground/70">
            {chip.name}
          </Text>
        </Pressable>
      ))}
      {overflow.length > 0 &&
        (bulkEditing ? (
          <Pressable
            role="button"
            onPress={() => toggleSelected(link)}
            className={`shrink-0 ${TAG_CHIP_CLASS}`}
          >
            <Text className="text-xs leading-4 text-foreground/70">+{overflow.length}</Text>
          </Pressable>
        ) : (
          <DropdownMenu onOpenChange={onOverflowOpenChange}>
            <DropdownMenuTrigger asChild>
              <Pressable
                role="button"
                aria-label={`Show ${overflow.length} more ${overflow.length === 1 ? 'tag' : 'tags'}`}
                className={`shrink-0 ${TAG_CHIP_CLASS}`}
              >
                <Text className="text-xs leading-4 text-foreground/70">+{overflow.length}</Text>
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
  );
}

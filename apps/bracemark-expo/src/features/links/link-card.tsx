// Grid card item for `linksLayout: 'card'` — the expo port of bracemark-web's card
// (`_layouts/card-layout.tsx` is the canonical doc for the card anatomy).
// FlashList's `numColumns` replaces web's virtualize-by-rows-of-N chunking
// (see main.tsx), so this file is only the card itself.
//
// INTRINSIC height, web's rationale: a card fits its content — one title line or
// two, chips or none — and the row it sits in is as tall as its tallest card. Web
// gets that from the grid (`items-stretch`); here FlashList's GridLayoutManager
// does the same job, giving every cell in a row the tallest cell's height as a
// `minHeight`, which the `grow` on the wrapper and the card below then fill. So
// the slack still falls at the BOTTOM of a shorter card (reads as padding, not as
// a gap mid-card) and the card borders in a row still line up.
//
// This replaces a fixed budget — a dp constant plus a font-scaled text part,
// since the OS font scale multiplies fontSize alone. That split existed because
// this was the one layout in the app where accessibility text scaling actually
// CLIPPED (the card is `overflow-hidden`); with the height measured, the card
// simply grows and the whole apparatus (the budget, the split, useCappedFontScale
// here) is gone. What's left as a number is the banner, and it isn't a budget:
// it's the card's own width times a ratio.
import { Linking, Pressable, View } from 'react-native';

import { displayUrl, hostFromText } from '@stxapps/shared';

import { Checkbox } from '../../components/ui/checkbox';
import { Text } from '../../components/ui/text';
import { Favicon, LinkPreviewImage } from './link-media';
import { LinkRowMenu } from './link-row-menu';
import { LinkTagChips } from './link-tag-chips';
import { type LinkItemProps, NoteBadge, PinnedBadge } from './shared';
import { useLinksViewState } from './view-state-provider';

// The banner is 12:7 — its height is 58.33% of the card's width — so it scales
// with the column count instead of being pinned to one number (web's
// `aspect-[12/7]`). Spelled as a HEIGHT computed off the item width main.tsx
// hands down rather than as an aspect class: the card already knows that width
// (the chip strip needs it), and a plain dp height needs nothing from the class
// layer to be exactly right on the first frame — which is what keeps the cell
// from measuring twice as the image resolves.
const PREVIEW_ASPECT = 7 / 12;
// The card's own width, off that item width: the wrapper's p-2 (16). No cap to
// go with web's `max-w-105` — web needs one because a one-column pane can hand a
// card 600px, while MIN_CARD_WIDTH 180 (main.tsx) keeps a cell here under ~360
// on any device that reaches one column at all.
const CARD_H_CHROME = 16;

// What the card can spare for the tag strip, off the same item width
// (link-tag-chips.tsx does the fitting): the wrapper's p-2 (16) plus the strip's
// px-3 (24). Nothing else shares the strip's line.
const CARD_CHIP_CHROME = 40;

export function LinkCard({
  link,
  pinned,
  isFirst,
  isLast,
  tagsById,
  itemWidth,
  selectMode,
  selected,
  onToggle,
}: LinkItemProps) {
  const { enterBulkEdit } = useLinksViewState();
  const host = hostFromText(link.url);
  const previewHeight = Math.round((itemWidth - CARD_H_CHROME) * PREVIEW_ASPECT);

  return (
    // p-2 is half the 16pt grid gutter: with the pane's matching content padding
    // (main.tsx CARD_GRID_PADDING), edges and inter-card gaps both come to 16 —
    // web's p-4 container + gap-4 grid. `grow`, not `flex-1`: flexGrow alone
    // leaves the cell's base size its CONTENT, which is what FlashList measures
    // on the first pass; `flex-1`'s flexBasis 0 would measure as an empty cell.
    <View className="grow p-2">
      {/* Two meanings, two roles, and long-press as the way into bulk-edit —
          see the twin comment in link-row.tsx for all three. */}
      <Pressable
        role={selectMode ? 'checkbox' : 'link'}
        aria-checked={selectMode ? selected : undefined}
        onPress={() => (selectMode ? onToggle() : void Linking.openURL(link.url))}
        onLongPress={
          selectMode
            ? undefined
            : () => {
                enterBulkEdit();
                onToggle();
              }
        }
        className={`grow overflow-hidden rounded-lg border border-border ${
          selected ? 'bg-muted' : 'active:bg-muted/50'
        }`}
      >
        {/* The banner: the preview image once its bytes are resident (fetched
            on demand by mounting — link-media.tsx), else the full-bleed hue
            panel. The height is the slot's, so both fallbacks fill it. */}
        <View style={{ height: previewHeight }}>
          <LinkPreviewImage link={link} className="h-full w-full" fallback="panel" />
        </View>
        <View className="gap-2 p-3">
          {/* The meta line: host, then the badges, then the ⋯ menu at the
              trailing edge (web's card, verbatim). The badges ride this line in
              all four layouts — web's list-layout.tsx carries the argument: the
              host is bounded where the title is not, so this is the line with
              slack. The menu joins them here rather than floating over the
              banner, so nothing covers the preview. It can sit INSIDE the card's
              Pressable on this platform (RN's responder hands the touch to the
              innermost pressable), which is the whole trick web has to buy with
              a stretched overlay. */}
          <View className="flex-row items-center gap-1.5">
            <Favicon host={host} className="size-4 shrink-0 rounded-sm" />
            <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-muted-foreground">
              {host}
            </Text>
            {pinned && <PinnedBadge />}
            {link.note !== undefined && link.note !== '' && <NoteBadge />}
            {selectMode ? (
              // The ⋯ menu's footprint (size-8), so entering bulk-edit swaps the
              // slot's contents without moving the line (web's LinkRowSelect).
              <View className="size-8 shrink-0 items-center justify-center">
                <Checkbox
                  aria-label={`Select ${link.title || displayUrl(link.url)}`}
                  checked={selected}
                  onCheckedChange={onToggle}
                />
              </View>
            ) : (
              <LinkRowMenu link={link} pinned={pinned} isFirst={isFirst} isLast={isLast} />
            )}
          </View>
          {/* text-base, not the list row's text-sm: a card is the layout with the
              most room per link, so its title reads at body size (web's card,
              verbatim). Two lines, and they cost nothing on the cards that use
              one — the card is intrinsic-height now. */}
          <Text numberOfLines={2} className="text-base font-medium">
            {link.title || displayUrl(link.url)}
          </Text>
        </View>
        <LinkTagChips
          link={link}
          tagsById={tagsById}
          availableWidth={itemWidth - CARD_CHIP_CHROME}
          className="px-3 pb-3"
        />
      </Pressable>
    </View>
  );
}

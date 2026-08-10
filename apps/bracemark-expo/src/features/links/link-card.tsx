// Grid card item for `linksLayout: 'card'` — the expo port of bracemark-web's card
// (`_layouts/card-layout.tsx` is the canonical doc for the card anatomy).
// FlashList's `numColumns` replaces web's virtualize-by-rows-of-N chunking
// (see main.tsx), so this file is only the card itself.
//
// FIXED height, web's rationale: cards with less content keep the height so the
// grid rows stay aligned — content flows top-down and the unused space falls at
// the BOTTOM (reads as bottom padding, not a mid-card gap). Budget: preview
// slot (112 — image or fallback panel, fixed either way) + p-3 text block
// (host line 16 + gap 8 + two title lines 40 + padding 24) + one chip line +
// pb-3 (32) = 232. No date column (web parity)
// and no inline note text (NoteBadge only — web's fixed-estimate rationale).
//
// That budget is drawn in UNSCALED dp, so it can't be a constant: the text in
// it grows with the device font scale while the box would not, and the overage
// disappears into `overflow-hidden` (this is the one layout in the app where
// accessibility text scaling actually clips — the list row is intrinsic-height
// and just grows). So split the budget and scale only the text-driven part:
//
//   fixed  156 = preview 112 + gap 8 + p-3 24 + pb-3 12
//   text    76 = host line 16 + two title lines 40 + chip line 20
//
// at scale 1.0 that is exactly the 232 above, so the design baseline is
// unchanged. `useCappedFontScale` applies the same ceiling the text itself is
// capped at (lib/font-scale.ts), which is what keeps the growth bounded —
// without the cap this would track Dynamic Type all the way to ~310%.

import { Linking, Pressable, View } from 'react-native';

import { displayUrl, hostFromText } from '@stxapps/shared';

import { Checkbox } from '../../components/ui/checkbox';
import { Text } from '../../components/ui/text';
import { useCappedFontScale } from '../../lib/font-scale';
import { Favicon, LinkPreviewImage } from './link-media';
import { LinkRowMenu } from './link-row-menu';
import { LinkTagChips } from './link-tag-chips';
import { type LinkItemProps, NoteBadge, PinnedBadge } from './shared';

const CARD_FIXED_HEIGHT = 156;
const CARD_TEXT_HEIGHT = 76;

export function LinkCard({
  link,
  pinned,
  isFirst,
  isLast,
  tagsById,
  selectMode,
  selected,
  onToggle,
}: LinkItemProps) {
  const host = hostFromText(link.url);
  const fontScale = useCappedFontScale();
  // Ceil so rounding can only ever give the text MORE room, never less.
  const cardHeight = CARD_FIXED_HEIGHT + Math.ceil(CARD_TEXT_HEIGHT * fontScale);

  return (
    // p-2 is half the 16pt grid gutter: with the pane's matching content padding
    // (main.tsx CARD_GRID_PADDING), edges and inter-card gaps both come to 16 —
    // web's p-4 container + gap-4 grid.
    <View className="p-2">
      <Pressable
        onPress={() => (selectMode ? onToggle() : void Linking.openURL(link.url))}
        accessibilityState={selectMode ? { selected } : undefined}
        style={{ height: cardHeight }}
        className={`overflow-hidden rounded-lg border border-border ${
          selected ? 'bg-muted' : 'active:bg-muted/50'
        }`}
      >
        {/* The banner: the preview image once its bytes are resident (fetched
            on demand by mounting — link-media.tsx), else the full-bleed hue
            panel. Fixed h-28 either way (the height budget above). */}
        <LinkPreviewImage link={link} className="h-28 w-full" fallback="panel" />
        <View className="gap-2 p-3">
          <View className="flex-row items-center gap-1.5">
            {pinned && <PinnedBadge />}
            {link.note !== undefined && link.note !== '' && <NoteBadge />}
            <Favicon host={host} className="size-4 shrink-0 rounded-sm" />
            <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-muted-foreground">
              {host}
            </Text>
          </View>
          <Text numberOfLines={2} className="text-sm font-medium">
            {link.title || displayUrl(link.url)}
          </Text>
        </View>
        <LinkTagChips link={link} tagsById={tagsById} className="px-3 pb-3" />
        {/* Floats over the banner (web's corner slot: the row menu, swapped for
            the selection checkbox while bulk editing), so give it a readable
            backdrop. */}
        <View className="absolute top-1 right-1 rounded-md bg-background/60">
          {selectMode ? (
            <View className="p-1">
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
      </Pressable>
    </View>
  );
}

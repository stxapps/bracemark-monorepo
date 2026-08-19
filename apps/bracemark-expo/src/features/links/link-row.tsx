// Dense one-row-per-link item, the default `linksLayout` — the expo port of
// bracemark-web's list-layout row (`_layouts/list-layout.tsx` is the canonical doc
// for the row anatomy). The leading 64×40 thumbnail is the row's at-a-glance
// identity, and the host line carries the site favicon (both from
// link-media.tsx, web's slots).
//
// The date column shows the field the rows are SORTED by (web's rationale:
// relative values must read top-to-bottom in order). Formatted by hand rather
// than Intl.RelativeTimeFormat — Hermes' Intl coverage is uneven across
// platforms, and the compact "3d" style suits the narrow column anyway.

import { Linking, Pressable, View } from 'react-native';

import { type LinkView } from '@stxapps/expo-react';
import { displayUrl, hostFromText } from '@stxapps/shared';

import { Checkbox } from '../../components/ui/checkbox';
import { Text } from '../../components/ui/text';
import { Favicon, LinkPreviewImage } from './link-media';
import { LinkRowMenu } from './link-row-menu';
import { LinkTagChips } from './link-tag-chips';
import { type LinkItemProps, NoteBadge, PinnedBadge } from './shared';
import { useLinksViewState } from './view-state-provider';

const MINUTE = 60 * 1000;
const RELATIVE_UNITS: [string, number][] = [
  ['y', 365 * 24 * 60 * MINUTE],
  ['mo', 30 * 24 * 60 * MINUTE],
  ['w', 7 * 24 * 60 * MINUTE],
  ['d', 24 * 60 * MINUTE],
  ['h', 60 * MINUTE],
  ['m', MINUTE],
];

// Compact "3d" / "2mo" for the date column: the largest unit that fits.
function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (diff >= ms) return `${Math.round(diff / ms)}${unit}`;
  }
  return 'now';
}

// What the row can spare for the tag strip, off the item width main.tsx hands
// down (link-tag-chips.tsx does the fitting). Left to right: pl-4 + pr-2 (24),
// the two gap-3s bracketing the date column (24), the date column itself at its
// widest ("12mo", font-scaled — 34), the ⋯ menu's size-8 (32), and inside the
// text box the thumbnail's w-16 plus its gap-3 (76).
//
// One number for both modes, deliberately: bulk-edit drops the menu (32 + a
// 12pt gap) and inserts a size-4 checkbox (16 + a 12pt gap), so a selecting row
// is 16pt ROOMIER. Budgeting the tighter shape for both means entering the mode
// can't reflow the chips under the user's thumb — 16pt buys a couple of
// characters, not a chip.
const ROW_CHIP_CHROME = 190;

// Whether this row renders a chip strip, and so which of its two shapes it
// takes: exactly the test LinkTagChips applies before it renders anything, so
// the two must not drift. A plain `tagIds.length > 0` would be subtly wrong — a
// tag deleted or not yet synced resolves to no chip, and so to no strip. Web
// carries the same predicate for the row-height ESTIMATES both its layouts feed
// their virtualizer (`_layouts/shared/link-tag-chips.tsx`, hasKnownTags); here
// every height is measured, so it feeds FlashList's recycle pools instead
// (main.tsx, LayoutConfig.itemType — the card's as well as the row's).
export const hasKnownTags = (link: LinkView, tagsById: Map<string, string>) =>
  link.tagIds.some((id) => tagsById.has(id));

export function LinkRow({
  link,
  pinned,
  isFirst,
  isLast,
  sortOn,
  tagsById,
  itemWidth,
  selectMode,
  selected,
  onToggle,
}: LinkItemProps) {
  const { enterBulkEdit } = useLinksViewState();

  // The role follows the press, because the press has two meanings. In bulk-edit
  // the whole row IS the checkbox — Pressable is `accessible`, so it collapses the
  // inner Checkbox's semantics into itself and has to re-declare them
  // (docs/accessibility.md, the same rule as the settings confirmation rows).
  // Otherwise the press leaves the app for the browser, which is a link, not a
  // button.
  //
  // Long-press enters bulk-edit with this row already picked — the platform
  // idiom (Photos, Files, Mail), and the reason it's here rather than on web:
  // desktop binds click-and-hold to a drag, and a touch browser binds it to the
  // link context menu, so web keeps its visible topbar toggle instead.
  // Deliberately ONLY the way in — once selecting, a long-press falls through
  // to onPress and just toggles, since RN only skips onPress when onLongPress
  // actually fires. The ⋯ menu's "Select" stays: a gesture has no AT
  // equivalent, so it can enhance this entry point but never be the only one.
  // No haptic tick on the pick-up, for the reason drag-sort.tsx records at its
  // own seam — expo-haptics is a native module and a prebuild, a dependency
  // decision rather than a code one.
  return (
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
      className="flex-row items-center gap-3 border-b border-border py-3 pr-2 pl-4 active:bg-muted/50"
    >
      {selectMode && (
        <Checkbox
          aria-label={`Select ${link.title || displayUrl(link.url)}`}
          checked={selected}
          onCheckedChange={onToggle}
          className="shrink-0"
        />
      )}
      {/* Thumbnail + text share a TOP edge, so they get their own `items-start`
          box while the row stays `items-center` for the date and the ⋯ menu
          (web's list layout, verbatim — see its comment for why centring the
          thumbnail stopped working once rows differed in height).

          The thumbnail stays in bulk-edit mode — it's the row's at-a-glance
          identity, so the checkbox is inserted, not swapped in (web's list
          layout, verbatim). Fixed-size slot; `overflow-hidden` clips the
          image's corners to the rounding. */}
      <View className="min-w-0 flex-1 flex-row items-start gap-3">
        {/* mt-0.5 pays back the title's half-leading, so the image starts on
            the title's ink rather than on its line box (web's list layout —
            see there for the arithmetic). */}
        <LinkPreviewImage
          link={link}
          className="mt-0.5 h-10 w-16 shrink-0 overflow-hidden rounded"
          iconClassName="size-4 rounded"
        />
        <View className="min-w-0 flex-1">
          {/* The title line holds the title ALONE (web's list layout, verbatim):
              a phone is the narrowest pane there is, so every pixel goes to the
              one string that identifies the link. TWO lines for the same reason —
              at this width one line fits only a few words and cuts most titles
              mid-phrase. It costs nothing on the rows that don't need it: the row
              is intrinsic-height, so a short title still renders one line and the
              row stays short. (Web reserves nothing either, but had to start
              measuring its rows to get there — see list-layout.tsx.)

              Web pairs this with a `title` tooltip for the remainder past two
              lines; there's no RN equivalent and none is needed — `numberOfLines`
              truncates the PAINT, not the accessible text, so a screen reader
              still reads the whole title, and the row menu's editor is the
              sighted path. */}
          <Text numberOfLines={2} className="text-sm font-medium">
            {link.title || displayUrl(link.url)}
          </Text>
          {/* text-sm to match the title, mt-0.5 so the lines don't touch, size-3.5
              so the favicon sits just under the cap height (web's list layout,
              verbatim). BOTH platforms measure the row now — FlashList always
              did, and web's list layout does too — so these numbers only have to
              look right, not add up to a budget.

              The badges ride THIS line in all four layouts (web's list layout
              carries the argument: a host is bounded where a title is not, so
              this is the line with slack to spend). 14px inside a 20px line box,
              so the row's look doesn't move. */}
          <View className="mt-0.5 flex-row items-center gap-1.5">
            <Favicon host={hostFromText(link.url)} className="size-3.5 shrink-0 rounded-sm" />
            <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-muted-foreground">
              {hostFromText(link.url)}
            </Text>
            {pinned && <PinnedBadge />}
            {link.note !== undefined && link.note !== '' && <NoteBadge />}
          </View>
          <LinkTagChips
            link={link}
            tagsById={tagsById}
            availableWidth={itemWidth - ROW_CHIP_CHROME}
            className="mt-3"
          />
        </View>
      </View>
      <Text className="shrink-0 text-xs text-muted-foreground">
        {formatRelativeTime(link[sortOn])}
      </Text>
      {/* Hidden while selecting — the checkbox column stands in (web's list
          layout, verbatim). */}
      {!selectMode && <LinkRowMenu link={link} pinned={pinned} isFirst={isFirst} isLast={isLast} />}
    </Pressable>
  );
}

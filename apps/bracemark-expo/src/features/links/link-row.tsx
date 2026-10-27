// Dense one-row-per-link item, the default `linksLayout` — the expo port of
// bracemark-web's list-layout row (`_layouts/list-layout.tsx` is the canonical doc
// for the row anatomy). The leading 64×40 thumbnail is the row's at-a-glance
// identity, and the host line carries the site favicon (both from
// link-media.tsx, web's slots).
//
// The date column shows the field the rows are SORTED by (web's rationale:
// relative values must read top-to-bottom in order), and its verb says which —
// relative-time.tsx carries the format and the accessible name.

import { memo } from 'react';
import { Pressable, View } from 'react-native';

import { type LinkView } from '@stxapps/expo-react';
import { displayUrl, hostFromText } from '@stxapps/shared';

import { Checkbox } from '../../components/ui/checkbox';
import { Text } from '../../components/ui/text';
import { Favicon, LinkPreviewImage } from './link-media';
import { LinkRowMenu } from './link-row-menu';
import { LinkTagChips } from './link-tag-chips';
import { RelativeTime } from './relative-time';
import { type LinkItemProps, NoteBadge, openLink, PinnedBadge } from './shared';
import { useLinksViewActions } from './view-state-provider';

// Web reveals its sorted-field date at the pane's `@xl` container query: 36rem,
// or 576px at Tailwind's 16px root. Use the row width main.tsx hands down rather
// than Uniwind's viewport `lg:` (64rem): the row is the thing whose title the
// date competes with, and the two breakpoint scales do not mean the same width.
// So the date never shows on a phone held upright, and does on a phone on its
// side, a tablet and an unfolded foldable — wherever the ROW reaches 576, which
// with the docked rail (features/links/sidebar-rail.tsx) is narrower than the window.
const RELATIVE_TIME_MIN_ROW_WIDTH = 576;

// What a row is told of its width (main.tsx, LayoutConfig.itemWidth): which side
// of the date breakpoint it is on, and nothing finer, because that is all it
// draws from. `itemWidth` is a memo'd prop of every mounted item, so the exact
// width would re-render every row on any change to the pane — and docking or
// putting away the rail (features/links/sidebar-rail.tsx) changes it by 280 on a
// tap, while the rows draw exactly what they drew before. Snapped, a rail toggle
// re-renders no row unless the date column actually comes or goes. The row's
// text still re-wraps and FlashList still re-measures; that is native layout,
// not React work. The card is told its full width: its banner is sized off it.
export const rowItemWidth = (cellWidth: number) =>
  cellWidth >= RELATIVE_TIME_MIN_ROW_WIDTH ? RELATIVE_TIME_MIN_ROW_WIDTH : 0;

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

export const LinkRow = memo(function LinkRow({
  link,
  pinned,
  pinnedAbove,
  pinnedBelow,
  sortOn,
  tagsById,
  itemWidth,
  selectMode,
  selected,
  onToggle,
}: LinkItemProps) {
  const { enterBulkEdit } = useLinksViewActions();
  const showRelativeTime = itemWidth >= RELATIVE_TIME_MIN_ROW_WIDTH;

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
  //
  // TRAP: the handler stays set WHILE selecting, where it only toggles. RN
  // decides at RELEASE whether a long-press swallows the press, and it asks the
  // handlers the Pressable holds THEN (Pressability: `onLongPress != null` in the
  // current config), not whether one fired. The entering long-press re-renders
  // this row into select mode before the finger lifts, so with the handler gone
  // the release fell through to onPress and unpicked the row it had just picked.
  // (Unseen while toggling bulk-edit's RefreshControl remounted every cell
  // mid-gesture — main.tsx — which dropped the release altogether.) So while
  // selecting a long-press toggles once, at the delay rather than on release;
  // enterBulkEdit is a no-op then. The ⋯ menu's "Select" stays: a gesture has
  // no AT equivalent, so it can enhance this entry point but never be the only
  // one.
  // No haptic tick on the pick-up, for the reason drag-sort.tsx records at its
  // own seam — expo-haptics is a native module and a prebuild, a dependency
  // decision rather than a code one.
  return (
    <Pressable
      role={selectMode ? 'checkbox' : 'link'}
      aria-checked={selectMode ? selected : undefined}
      onPress={() => (selectMode ? onToggle(link) : openLink(link.url))}
      onLongPress={() => {
        enterBulkEdit();
        onToggle(link);
      }}
      // The selected fill, `bg-muted`, is the same one link-card.tsx paints and the
      // same one both web layouts paint — the checkbox is the state's precise
      // readout, the fill is what makes a selection legible as a BLOCK while
      // scanning a long list, and it is the only cue left on a row whose checkbox
      // has scrolled under a thumb. It replaces the press highlight rather than
      // layering on it: a selected row that could still light darker on press
      // would read as a third state.
      className={`flex-row items-center gap-3 border-b border-border py-3 pr-2 pl-4 ${
        selected ? 'bg-muted' : 'active:bg-muted/50'
      }`}
    >
      {selectMode && (
        <Checkbox
          aria-label={`Select ${link.title || displayUrl(link.url)}`}
          checked={selected}
          onCheckedChange={() => onToggle(link)}
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
              so the row's look doesn't move.

              And they ride it NEXT TO the host, which is what `shrink` on the
              host buys over the `flex-1` this used to carry. `flex-1` made the
              host claim the whole line whatever it held, so the badges were
              pushed out to the row's trailing edge and read as a column of
              their own — sometimes a hand's width from the link they annotate,
              and not what web paints (its host is a bare `truncate`, sized to
              its text). Spelled out because RN children do not shrink by
              default: Yoga's flexShrink is 0 where the web's is 1, so the class
              is doing what web gets for free. It is also enough on its own —
              Yoga implements no `min-width: auto` min-content floor
              (link-tag-chips.tsx carries that note), so a long host ellipsizes
              here instead of shoving the badges off the row. The `min-w-0` that
              rode along with the `flex-1` was always a no-op for the same
              reason. */}
          <View className="mt-0.5 flex-row items-center gap-1.5">
            <Favicon host={hostFromText(link.url)} className="size-3.5 shrink-0 rounded-sm" />
            <Text numberOfLines={1} className="shrink text-sm text-muted-foreground">
              {hostFromText(link.url)}
            </Text>
            {pinned && <PinnedBadge />}
            {link.note !== undefined && link.note !== '' && <NoteBadge />}
          </View>
          <LinkTagChips link={link} tagsById={tagsById} selectMode={selectMode} className="mt-3" />
        </View>
      </View>
      {showRelativeTime && (
        <RelativeTime
          epochMs={link[sortOn]}
          verb={sortOn === 'createdAt' ? 'Added' : 'Updated'}
          className="shrink-0"
        />
      )}
      {/* Hidden while selecting — the checkbox column stands in (web's list
          layout, verbatim). */}
      {!selectMode && (
        <LinkRowMenu
          link={link}
          pinned={pinned}
          pinnedAbove={pinnedAbove}
          pinnedBelow={pinnedBelow}
        />
      )}
    </Pressable>
  );
});

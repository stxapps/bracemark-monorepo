'use client';

import { useLayoutEffect, useRef, useState } from 'react';

import { type LinkView } from '@stxapps/web-react';
import { Popover, PopoverContent, PopoverTrigger } from '@stxapps/web-ui/components/ui/popover';

import { useLinksPage } from '../../_contexts/page-provider';
import { useLinksViewState } from '../../_contexts/view-state-provider';
import { useEngagedOpen } from './hooks';

// 24px tall exactly: py-1 (4+4) around a 16px line box. `leading-4` is spelled
// out rather than left to `text-xs`'s default because both layouts' row-height
// ESTIMATES are built from that 24 (and bracemark-expo's chip copies it), so a
// theme that retuned `--text-xs--line-height` would quietly put every estimate
// a line out of step with what the rows measure.
//
// Weight 400, not 500: the row title is `text-sm font-medium`, and a chip at the
// same weight competes with it for the eye. Tags are metadata; the size and the
// pill already mark them, so the weight doesn't have to.
//
// `text-foreground/80` rather than the obvious `text-muted-foreground`, which is
// the token for quiet text everywhere else in the row and is WRONG here for a
// reason that only shows up on the pill: that token is calibrated against the
// page BACKGROUND, and the chip is not the page background. Ours is already
// lowered to 0.54 for this whole family of wash surfaces (styles.css carries
// that argument), and on the fills below it still reads 4.41:1 / 4.25:1 / 4.06:1
// as the item moves under it — under the 4.5:1 AA floor, at 12px, from a change
// that touches no layout and breaks no test. The alpha is mixed against the pill
// instead, and lands 6.6:1 at worst in light and 6.8:1 in dark across every
// state either can reach: clearly lighter than `text-secondary-foreground`'s
// 16.4:1, with margin to spare. Anything below /60 walks back into
// muted-foreground's territory and its problem.
//
// The FILL is an alpha toward the foreground, and this is the one rule here that
// can't be eyeballed from the class list. A chip sits on an ITEM, and an item has
// three surfaces: plain, `hover:bg-muted/50`, and `bg-muted` while selected.
// `--secondary`, `--muted` and `--accent` are all the same grey in this palette,
// so the obvious `bg-secondary` pill stepped 10/255 off a plain light row, 5 off
// a hovered one, and 0 off a selected one — the strip vanishing outright at the
// exact moment the user is picking links by hand, with nothing to fail. And
// `bg-secondary/80` is worse rather than better: alpha toward a colour that
// EQUALS the backdrop converges on it, 245 → 246 in light, and in dark it moved
// the WRONG WAY, 38 → 35.
//
// Alpha toward `--foreground` diverges from all three by construction — every
// item surface in both themes sits on the foreground's opposite side — so the
// step is proportional to the alpha and to nothing else, and cannot collapse on
// any of them: 15/14/14 of 255 across the three in light, 14/14/13 in dark, and
// the same again on `--popover` behind the "+N" chip. Hover doubles the alpha,
// for a step the size of the base one. An OPAQUE mix (`color-mix(in oklch,
// var(--secondary), var(--foreground) 5%)`, the Button's secondary variant)
// clears all three too, but unevenly: being a fixed colour, its step SHRINKS as
// the surface moves toward it — down to 9/255 on a selected dark row, the state
// that started this — and it would need a real theme token to say on expo, where
// `color-mix` does not exist. The alpha is one string both apps share verbatim
// (bracemark-expo's `features/links/link-tag-chips.tsx`, `active:` where this
// has `hover:`).
//
// Which is also why nothing in this file reads the selection: one fill answers
// all three surfaces, so a chip never has to know what its item is doing.
const TAG_CHIP_CLASS =
  'max-w-32 shrink-0 truncate rounded-full bg-foreground/6 px-2 py-1 text-xs leading-4 text-foreground/80 hover:bg-foreground/12';

// Whether the strip renders anything for this link — EXACTLY the test the
// component applies below, hoisted so a layout can ask it before rendering. Both
// use it to pick a row-height estimate (list-layout's two row shapes,
// card-layout's two), and a plain `tagIds.length > 0` would be subtly wrong: a
// tag deleted or not yet synced resolves to no chip, and so to no strip. Keeping
// it here is what stops the two from drifting apart. (bracemark-expo carries the
// same predicate beside its row — link-row.tsx — where it also feeds FlashList's
// recycle pools.)
export const hasKnownTags = (link: LinkView, tagsById: Map<string, string>) =>
  link.tagIds.some((id) => tagsById.has(id));

// gap-1 on the chip row and clone (both axes); the measurement math mirrors it
// when asking whether the "+N" chip still fits after a kept chip.
const CHIP_GAP_PX = 4;

// The row's tag chips: one button per tag, in the link's own `tagIds` order,
// each navigating to that tag's view via setSimpleQuery — the same canonical
// `/links?tag=…` URL the sidebar writes, so highlight/back-button behavior comes
// for free. Rendered OUTSIDE the row's <a> (a button inside an anchor is invalid
// and would fire the navigation — same rule as LinkRowMenu). Ids the map doesn't
// know (a tag deleted / not yet synced) are skipped; no tags renders nothing.
//
// In bulk-edit mode the whole strip goes INERT: plain spans, and
// `pointer-events-none` on the wrapper so a click passes straight through to
// whatever owns the item's click (list-layout's row handler, card-layout's
// full-card overlay). Chips that toggled the selection themselves — which is
// what this did — looked equivalent and weren't: they ignored `shiftKey` where
// every other part of the item extends a range, they left the gaps between pills
// and the whole tail past the last one dead, and once the item owns the click a
// chip that also toggles toggles TWICE, which reads as a row refusing to select.
// Spans also drop the strip out of the tab order, which is honest — "filter by
// this tag" is not available in the mode, and a focusable control that does
// something else instead is worse than no focus stop.
//
// The strip gets a line budget (`maxLines`) and MEASURES how many chips fit it;
// the rest collapse behind an in-flow "+N" chip that opens a popover holding
// them (still clickable, same navigation). Measurement, not a fixed cap: the
// column widths are responsive and tag names vary, so the fit is only knowable
// from real geometry. BOTH layouts take the default ONE line today — the card
// used to spend two, and gave it up so that a card here and a card in
// bracemark-expo show the same chips (its strip is one line and can't be more:
// link-tag-chips.tsx there estimates the fit rather than measuring it, because
// RN has no synchronous pre-paint measure). The budget stays a parameter because
// the fit is expressed in lines either way, not because a caller varies it. An invisible absolutely-positioned clone renders ALL
// chips with the same metrics but ALWAYS wrapping (so overflow folds into
// measurable lines even for a single-line row); a layout effect keeps the
// chips whose clone line is within budget — and on the last line only while
// the "+N" probe still fits after them — and a ResizeObserver re-measures as
// the row resizes. The visible row paints only the kept chips, so nothing is
// ever half-clipped or occluded; its overflow-hidden is just a backstop. In
// bulk-edit mode "+N" is inert like every other chip (no popover).
export function LinkTagChips({
  link,
  tagsById,
  maxLines = 1,
  className = '',
}: {
  link: LinkView;
  tagsById: Map<string, string>;
  maxLines?: number;
  className?: string;
}) {
  const { setSimpleQuery } = useLinksPage();
  const { bulkEditing } = useLinksViewState();
  const [overflowOpen, setOverflowOpen] = useEngagedOpen();

  const tags = link.tagIds.flatMap((id) => {
    const name = tagsById.get(id);
    return name === undefined ? [] : [{ id, name }];
  });

  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(tags.length);
  // Chip widths depend on the names; the container width is the
  // ResizeObserver's job, so names are the effect's only geometry dep.
  const namesKey = tags.map((t) => t.name).join('\n');

  useLayoutEffect(() => {
    const clone = measureRef.current;
    if (!clone) return;

    const measure = () => {
      const chips = Array.from(clone.children) as HTMLElement[];
      const more = chips.pop(); // the clone's last child is the "+N" width probe
      if (!more || chips.length === 0) return;
      const width = clone.clientWidth;
      const firstTop = chips[0].offsetTop;
      const lineStride = chips[0].offsetHeight + CHIP_GAP_PX;
      const lineOf = (el: HTMLElement) => Math.round((el.offsetTop - firstTop) / lineStride);

      // Keep the chips whose clone line is within budget...
      let kept = chips.length;
      while (kept > 0 && lineOf(chips[kept - 1]) >= maxLines) kept -= 1;
      if (kept < chips.length) {
        // ...then make room for "+N" on the last allowed line: drop trailing
        // kept chips until it fits after them. Chips on earlier lines always
        // stay — if the whole last line empties, "+N" starts it alone.
        while (kept > 0) {
          const el = chips[kept - 1];
          if (lineOf(el) < maxLines - 1) break;
          if (el.offsetLeft + el.offsetWidth + CHIP_GAP_PX + more.offsetWidth <= width) break;
          kept -= 1;
        }
      }
      setVisibleCount(kept);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(clone);
    return () => observer.disconnect();
  }, [namesKey, maxLines]);

  if (tags.length === 0) return null;

  const onTagClick = (id: string) => setSimpleQuery({ kind: 'tag', id });

  // State may lag a beat behind the tag list (the layout effect re-clamps
  // before paint); render from the clamped value so a shrink never overslices.
  const count = Math.min(visibleCount, tags.length);
  const visible = tags.slice(0, count);
  const overflow = tags.slice(count);
  // The visible row wraps only when the budget allows it — for a single-line
  // row, nowrap keeps an off-by-one from folding into a second (unbudgeted)
  // line; horizontal clipping is the safer failure.
  const wrapClass = maxLines > 1 ? 'flex-wrap' : '';

  return (
    // The inert half of the bulk-edit rule above rides the OUTER div, so the
    // caller's padding (card-layout's `px-3 pb-3`) is click-through as well —
    // that padding is item surface too, and a strip that only passed its pills
    // through would still hold a dead frame around them.
    <div className={`${className} ${bulkEditing ? 'pointer-events-none' : ''}`}>
      <div className={`relative flex gap-1 overflow-hidden ${wrapClass}`}>
        {visible.map(({ id, name }) =>
          bulkEditing ? (
            <span key={id} className={TAG_CHIP_CLASS}>
              {name}
            </span>
          ) : (
            <button
              key={id}
              type="button"
              className={TAG_CHIP_CLASS}
              onClick={() => onTagClick(id)}
            >
              {name}
            </button>
          ),
        )}
        {overflow.length > 0 &&
          (bulkEditing ? (
            <span className={TAG_CHIP_CLASS}>+{overflow.length}</span>
          ) : (
            <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={TAG_CHIP_CLASS}
                  aria-label={`Show ${overflow.length} more ${overflow.length === 1 ? 'tag' : 'tags'}`}
                >
                  +{overflow.length}
                </button>
              </PopoverTrigger>
              {/* Portaled, so chip clicks land outside the row entirely (same as
                  LinkRowMenu's content); stopPropagation for symmetry anyway. */}
              <PopoverContent
                align="start"
                className="w-auto max-w-64 p-2"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex flex-wrap gap-1">
                  {overflow.map(({ id, name }) => (
                    <button
                      key={id}
                      type="button"
                      className={TAG_CHIP_CLASS}
                      onClick={() => {
                        setOverflowOpen(false);
                        onTagClick(id);
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          ))}
        {/* Measurement clone: every chip plus the "+N" width probe (at its
            widest possible text), same metrics as the real chips but always
            wrapping. Absolute → out of flow (no height contribution),
            invisible → painted by neither eye nor AT, but offsets still
            measurable. inset-x-0 pins its width to the row's, which is why the
            caller's padding lives on the OUTER div, not this row. */}
        <div
          ref={measureRef}
          aria-hidden
          className="invisible absolute inset-x-0 top-0 flex flex-wrap gap-1"
        >
          {tags.map(({ id, name }) => (
            <span key={id} className={TAG_CHIP_CLASS}>
              {name}
            </span>
          ))}
          <span className={TAG_CHIP_CLASS}>+{tags.length}</span>
        </div>
      </div>
    </div>
  );
}

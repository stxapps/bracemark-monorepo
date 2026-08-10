'use client';

import { useLayoutEffect, useRef, useState } from 'react';

import { type LinkView } from '@stxapps/web-react';
import { Popover, PopoverContent, PopoverTrigger } from '@stxapps/web-ui/components/ui/popover';

import { useLinksPage } from '../../_contexts/page-provider';
import { useLinksViewState } from '../../_contexts/view-state-provider';
import { useEngagedOpen } from './hooks';

const TAG_CHIP_CLASS =
  'max-w-32 shrink-0 truncate rounded-full bg-secondary px-2 py-px text-[11px] font-medium text-secondary-foreground hover:bg-secondary/80';

// gap-1 on the chip row and clone (both axes); the measurement math mirrors it
// when asking whether the "+N" chip still fits after a kept chip.
const CHIP_GAP_PX = 4;

// The row's tag chips: one button per tag, in the link's own `tagIds` order,
// each navigating to that tag's view via setSimpleQuery — the same canonical
// `/links?tag=…` URL the sidebar writes, so highlight/back-button behavior comes
// for free. Rendered OUTSIDE the row's <a> (a button inside an anchor is invalid
// and would fire the navigation — same rule as LinkRowMenu). In bulk-edit mode a
// chip toggles the row's selection instead, matching the row click. Ids the map
// doesn't know (a tag deleted / not yet synced) are skipped; no tags renders
// nothing.
//
// The rows are fixed-height, so chips get a line budget (`maxLines`, the card
// layout's two vs the list's one) and the component MEASURES how many fit it;
// the rest collapse behind an in-flow "+N" chip that opens a popover holding
// them (still clickable, same navigation). Measurement, not a fixed cap: the
// column widths are responsive and tag names vary, so the fit is only knowable
// from real geometry. An invisible absolutely-positioned clone renders ALL
// chips with the same metrics but ALWAYS wrapping (so overflow folds into
// measurable lines even for a single-line row); a layout effect keeps the
// chips whose clone line is within budget — and on the last line only while
// the "+N" probe still fits after them — and a ResizeObserver re-measures as
// the row resizes. The visible row paints only the kept chips, so nothing is
// ever half-clipped or occluded; its overflow-hidden is just a backstop. In
// bulk-edit mode "+N" toggles selection like every other chip (no popover).
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
  const { bulkEditing, toggleSelected } = useLinksViewState();
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

  const onTagClick = (id: string) =>
    bulkEditing ? toggleSelected(link) : setSimpleQuery({ kind: 'tag', id });

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
    <div className={className}>
      <div className={`relative flex gap-1 overflow-hidden ${wrapClass}`}>
        {visible.map(({ id, name }) => (
          <button key={id} type="button" className={TAG_CHIP_CLASS} onClick={() => onTagClick(id)}>
            {name}
          </button>
        ))}
        {overflow.length > 0 &&
          (bulkEditing ? (
            <button type="button" className={TAG_CHIP_CLASS} onClick={() => toggleSelected(link)}>
              +{overflow.length}
            </button>
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

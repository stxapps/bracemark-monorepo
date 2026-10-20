import { progressPercent } from '@stxapps/shared';
import { cn } from '@stxapps/web-ui/lib/utils';

// The one drawing of a determinate job on the web surfaces: a bar, and under it
// TWO numbers — the count on the left ("340 of 1,000 changes"), the percent on
// the right. The first-sync gate, the Data card's cycle readout and the browser
// extension's sync detail all render it, so a sync looks the same wherever it is
// watched (bracemark-expo has its own copy: components/progress-meter.tsx).
//
// Why both numbers. The count EXPLAINS the wait — someone with a large library
// learns why it takes twenty seconds — and climbs in small steps, which is the
// best evidence of life a screen can give. The percent is what the eye reads at
// a glance and what the count can't say quickly at 4,000 of 9,000. Neither is
// invented: every caller's `total` is a fact counted before the job started
// (@stxapps/shared async/progress.ts), which is the whole licence for a bar.
//
// Motion. Callers repaint at PROGRESS_FLUSH_MS (100 ms), and the bar eases over
// two of those, so it glides between repaints instead of stepping; the fill is a
// translated full-width bar inside a clipping track (transform only, so the
// glide is the compositor's and the rounded end stays round at any width).
// `motion-reduce` drops the glide, not the update.
//
// Without `total` it draws the job's indeterminate stretch — work with no
// denominator yet, a listing — as a pulsing track: no fill, because a parked
// segment would read as a value. That state is `role="progressbar"` with no
// `aria-valuenow`, which is what ARIA defines as indeterminate.
//
// Accessibility (docs/accessibility.md, _the first-sync counter_): the
// progressbar carries the value as `aria-valuetext` — the same sentence the
// sighted user reads — and is NOT a live region. It repaints ten times a second,
// and announcing that would be a wall of numbers; a progressbar is read when the
// user reaches it. The caption row is `aria-hidden` so the count isn't read twice.
// `tabular-nums` keeps the row from twitching as digits change width.
export function ProgressMeter({
  label,
  done,
  total,
  valueText,
  className,
}: {
  // The progressbar's accessible name — what the job is ("Decrypting your links").
  label: string;
  done?: number;
  // Absent (or not positive) → the indeterminate state.
  total?: number;
  // The visible count line, also the progressbar's `aria-valuetext`. In the
  // indeterminate state, an optional line saying what is happening instead.
  valueText?: string;
  className?: string;
}) {
  const determinate = total !== undefined && total > 0 && done !== undefined;
  const percent = determinate ? progressPercent(done, total) : 0;
  // The fill uses the exact fraction, the text the floored percent: the bar may
  // creep within a percent, the number may not claim 100 before the last unit.
  const fraction = determinate ? Math.max(0, Math.min(1, done / total)) : 0;

  return (
    <div data-slot="progress-meter" className={cn('flex w-full flex-col gap-1.5', className)}>
      <div
        role="progressbar"
        aria-label={label}
        {...(determinate
          ? {
              'aria-valuemin': 0,
              'aria-valuemax': total,
              'aria-valuenow': done,
              'aria-valuetext': valueText,
            }
          : {})}
        className={cn(
          'h-1.5 w-full overflow-hidden rounded-full bg-muted',
          !determinate && 'animate-pulse motion-reduce:animate-none',
        )}
      >
        {determinate && (
          <div
            className="h-full w-full rounded-full bg-primary transition-transform duration-200 ease-out motion-reduce:transition-none"
            style={{ transform: `translateX(-${(1 - fraction) * 100}%)` }}
          />
        )}
      </div>
      {(valueText || determinate) && (
        <div
          aria-hidden
          className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground tabular-nums"
        >
          <span className="min-w-0 truncate">{valueText}</span>
          {determinate && <span className="shrink-0">{percent}%</span>}
        </div>
      )}
    </div>
  );
}
